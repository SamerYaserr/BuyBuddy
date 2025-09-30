import { v4 as uuidv4 } from "uuid";
import { TokenExpiredError } from "jsonwebtoken";

import env from "../../config/env.config";
import {
  SignupPayload,
  VerfiyEmail,
  LoginPayload,
  RefreshPayload,
  LogoutPayload,
  ForgetPasswordPayload,
  ResetPasswordPayload,
  HandleGoogleCallbackPayload,
  VerifyPasswordResetCode,
  ResetTokenPayload,
  ResendVerificationCode,
} from "./auth.type";
import prisma from "../../config/prisma.config";
import APIError from "../../utils/APIError";
import { Status, RevokedReason, Provider, Role } from "@prisma/client";
import { addEmailJob } from "../../jobs/email/email.job";
import { hashPassword, comparePassword } from "../../utils/hash";
import logger from "../../config/logger.config";
import {
  generateAccessToken,
  generateRefreshToken,
  generateResetToken,
  verifyRefreshToken,
  verifyResetToken,
} from "./token.service";
import {
  accountSafeSelect,
  accountLoginSelect,
  accountResetPasswordSelect,
} from "./auth.select";
import { generateNumericCode, hashCode, compareCode } from "./code.util";
import { HttpStatus } from "../../enums/httpStatus.enum";

class AuthService {
  private async generateAndSendVerificationCode(
    subject: string,
    email: string
  ) {
    const code = generateNumericCode();
    const hashed = await hashCode(code);

    const ttl = env.EMAIL_VERIFICATION_TTL_MINUTES;
    const expiresAt = new Date(Date.now() + ttl * 60 * 1000);

    await prisma.account.update({
      where: { email },
      data: {
        verificationCode: hashed,
        verificationCodeExpiresAt: expiresAt,
      },
    });

    await addEmailJob("verification", {
      to: email,
      code,
      subject,
    });
  }

  private async generateAndSendPasswordResetCode(
    subject: string,
    email: string
  ) {
    const code = generateNumericCode();
    const hashed = await hashCode(code);

    const ttl = env.PASSWORD_RESET_TTL_MINUTES;
    const expiresAt = new Date(Date.now() + ttl * 60 * 1000);

    await prisma.account.update({
      where: { email },
      data: {
        passwordResetCode: hashed,
        passwordResetCodeExpiresAt: expiresAt,
      },
    });

    await addEmailJob("passwordReset", {
      to: email,
      code,
      subject,
    });
  }

  async signup(payload: SignupPayload) {
    // Check if account already exists
    const existingaccount = await prisma.account.findUnique({
      where: { email: payload.email },
      select: accountSafeSelect,
    });

    if (existingaccount) {
      switch (existingaccount.status) {
        case Status.INACTIVE:
          throw new APIError(
            "Your account is inactive. Please request reactivation.",
            HttpStatus.Forbidden
          );

        case Status.UNVERIFIED:
          throw new APIError(
            "Your email is not verified. Please verify your account.",
            HttpStatus.Forbidden
          );

        case Status.SUSPENDED:
          throw new APIError(
            "Your account has been suspended. Please contact support.",
            HttpStatus.Forbidden
          );

        case Status.ACTIVE:
          throw new APIError("Account already exists.", HttpStatus.Conflict);

        default:
          throw new APIError(
            "Unknown account status.",
            HttpStatus.InternalServerError
          );
      }
    }

    if (payload.userName && payload.role === Role.BRAND) {
      throw new APIError(
        "Brand accounts cannot include a username.",
        HttpStatus.UnprocessableEntity
      );
    }

    if (payload.role === Role.USER && !payload.userName) {
      throw new APIError(
        "Username is required for user accounts.",
        HttpStatus.UnprocessableEntity
      );
    }

    if (
      payload.role === Role.BRAND &&
      (!payload.categories || payload.categories.length === 0)
    ) {
      throw new APIError(
        "At least one category is required for brand accounts.",
        HttpStatus.UnprocessableEntity
      );
    }

    if (payload.role === Role.USER && payload.categories) {
      throw new APIError(
        "Categories should not be provided for user accounts.",
        HttpStatus.UnprocessableEntity
      );
    }

    // Hash password and create new account
    payload.password = await hashPassword(payload.password);

    const data: any = {
      email: payload.email,
      password: payload.password,
      name: payload.name,
      status: Status.UNVERIFIED,
      role: payload.role,
      provider: Provider.LOCAL,
    };

    // Conditionally attach relation
    if (payload.role === Role.BRAND) {
      data.brand = { create: { categories: { set: payload.categories } } };
    } else if (payload.role === Role.USER) {
      data.user = { create: { userName: payload.userName } };
    }

    const account = await prisma.account.create({
      data,
      select: accountSafeSelect,
    });

    if (!account) {
      throw new APIError(
        "Failed to create account",
        HttpStatus.InternalServerError
      );
    }

    // Send verification code
    await this.generateAndSendVerificationCode(
      "Verify your email",
      account.email
    );

    logger.info(
      `New account registered ID: ${account.id}, name: ${account.name}`
    );
    return account;
  }

  async resendVerificationCode(payload: ResendVerificationCode) {
    const { email } = payload;
    const account = await prisma.account.findUnique({
      where: { email },
      select: accountSafeSelect,
    });

    if (!account) {
      throw new APIError(
        "No account found with this email.",
        HttpStatus.NotFound
      );
    }

    // If account already verified or active, block resending
    if (account.status === Status.ACTIVE) {
      throw new APIError(
        "This account is already verified.",
        HttpStatus.BadRequest
      );
    }

    // If suspended, block
    if (account.status === Status.SUSPENDED) {
      throw new APIError(
        "Your account has been suspended. Please contact support.",
        HttpStatus.Forbidden
      );
    }

    // Generate and send verification code
    await this.generateAndSendVerificationCode(
      account.status === Status.INACTIVE
        ? "Activate your account"
        : "Verify your email",
      account.email
    );

    logger.info(`Verification code resent for account ID: ${account.id}`);
    return {
      message: "Verification code resent successfully",
      account,
    };
  }

  async verifyEmail(payload: VerfiyEmail) {
    const { email, code } = payload;

    // Find account by email with only fields needed for verification
    const existingaccount = await prisma.account.findUnique({
      where: { email },
      select: {
        id: true,
        verificationCode: true,
        verificationCodeExpiresAt: true,
        status: true,
      },
    });

    // If no account found, return 404 (email does not exist)
    if (!existingaccount)
      throw new APIError("Invalid email", HttpStatus.NotFound);

    // If account has no verification code stored, ask to request a new one
    if (!existingaccount.verificationCode)
      throw new APIError(
        "Verification code not found. Please request a new one.",
        HttpStatus.BadRequest
      );

    // Check if verification code has expired
    if (
      !existingaccount.verificationCodeExpiresAt ||
      existingaccount.verificationCodeExpiresAt <= new Date()
    )
      throw new APIError(
        "Invalid or expired verification code.",
        HttpStatus.BadRequest
      );

    // Compare provided code with stored hashed code
    const ok = await compareCode(code, existingaccount.verificationCode);
    if (!ok)
      throw new APIError(
        "Invalid or expired verification code.",
        HttpStatus.BadRequest
      );

    // Update account to ACTIVE and clear verification fields after successful validation
    const account = await prisma.account.update({
      where: { email },
      data: {
        status: Status.ACTIVE,
        verificationCode: null,
        verificationCodeExpiresAt: null,
      },
      select: accountSafeSelect,
    });

    // If update somehow failed, return server error
    if (!account) {
      throw new APIError(
        "Failed to verify email",
        HttpStatus.InternalServerError
      );
    }

    // Generate access & refresh tokens for the verified account
    const accessToken = generateAccessToken({
      id: account.id,
      role: account.role,
      createdAt: account.createdAt,
      status: account.status,
      email: account.email,
    });
    const refreshToken = await generateRefreshToken({
      id: account.id,
      jti: uuidv4(),
    });

    if (existingaccount.status === Status.INACTIVE) {
      await addEmailJob("accountActivated", {
        to: account.email,
        subject: "Your account is now active",
        name: account.name,
      });
    } else {
      await addEmailJob("accountVerified", {
        to: account.email,
        subject: "Verify your email",
        name: account.name,
      });
    }

    logger.info(`account verified ID: ${account.id}, name: ${account.name}`);

    return { account, accessToken, refreshToken, emailQueued: true };
  }

  async login(payload: LoginPayload) {
    const { email, password } = payload;

    // Find account by email
    const account = await prisma.account.findUnique({
      where: {
        email,
      },
      select: accountLoginSelect,
    });

    // If no account found or password does not match, throw error
    if (!account || !(await comparePassword(password, account.password))) {
      throw new APIError("Invalid email or password", HttpStatus.Unauthorized);
    }

    // If account has not verified their email, resend verification code and block login
    if (account.status === Status.UNVERIFIED) {
      await this.generateAndSendVerificationCode(
        "Verify your email",
        account.email
      );

      throw new APIError(
        "Please verify your email to continue",
        HttpStatus.Forbidden
      );
    }

    // If account is inactive, resend activation code and block login
    if (account.status === Status.INACTIVE) {
      await this.generateAndSendVerificationCode(
        "Activate your account",
        account.email
      );

      throw new APIError(
        "Your account is inactive. Please check your email to activate your account.",
        HttpStatus.Forbidden
      );
    }

    // If account is suspended, block login
    if (account.status === Status.SUSPENDED) {
      throw new APIError(
        "Your account has been suspended. Please contact support.",
        HttpStatus.Forbidden
      );
    }

    const accessToken = generateAccessToken({
      id: account.id,
      role: account.role,
      createdAt: account.createdAt,
      status: account.status,
      email: account.email,
    });
    const refreshToken = await generateRefreshToken({
      id: account.id,
      jti: uuidv4(),
    });

    // Exclude the password field from the account object and keep the rest as safeaccount
    const { password: _, ...safeaccount } = account;

    logger.info(`account logged in ID: ${account.id}, name: ${account.name}`);
    return { account: safeaccount, accessToken, refreshToken };
  }

  async refresh(payload: RefreshPayload) {
    const { refreshToken } = payload;
    const decoded = await verifyRefreshToken(refreshToken);

    if (!decoded || !decoded.id || !decoded.jti) {
      throw new APIError("Invalid refresh token", HttpStatus.Unauthorized);
    }

    // find account
    const account = await prisma.account.findUnique({
      where: { id: decoded.id },
      select: accountSafeSelect,
    });

    // Ensure the account exists before proceeding with token refresh
    if (!account) {
      throw new APIError("account not found", HttpStatus.Forbidden);
    }

    // status checks
    if (account.status === Status.SUSPENDED) {
      throw new APIError(
        "Your account has been suspended. Please contact support.",
        HttpStatus.Forbidden
      );
    }

    // check if account is inactive
    if (account.status === Status.INACTIVE) {
      throw new APIError("account is not active", HttpStatus.Forbidden);
    }

    // Check if account is unverified
    if (account.status === Status.UNVERIFIED) {
      await this.generateAndSendVerificationCode(
        "Verify your email",
        account.email
      );

      throw new APIError(
        "Please verify your email to continue",
        HttpStatus.Forbidden
      );
    }

    // Look up the stored refresh-token record by jti
    const storedToken = await prisma.refreshToken.findUnique({
      where: { jti: decoded.jti },
    });

    // If token record doesn't exist or doesn't belong to account => invalid
    if (!storedToken || storedToken.accountId !== account.id) {
      throw new APIError("Invalid refresh token", HttpStatus.Unauthorized);
    }

    // If token was already revoked -> possible reuse (token theft)
    if (storedToken.revokedReason) {
      // Revoke all active refresh tokens for this account as a precaution
      await prisma.refreshToken.updateMany({
        where: { accountId: account.id, revokedReason: null },
        data: {
          revokedReason: RevokedReason.TOKEN_REUSE_DETECTED,
          revokedAt: new Date(),
        },
      });

      logger.warn(
        `Refresh token reuse detected for account ID ${account.id}, token ${storedToken.id}`
      );

      throw new APIError(
        "Refresh token has been revoked. Please login again.",
        HttpStatus.Unauthorized
      );
    }

    // Check expiration of stored refresh token (defense-in-depth)
    if (storedToken.expiresAt && storedToken.expiresAt < new Date()) {
      // mark it revoked for clarity
      await prisma.refreshToken.update({
        where: { id: storedToken.id },
        data: { revokedAt: new Date(), revokedReason: RevokedReason.EXPIRED },
      });

      throw new APIError(
        "Refresh token expired. Please login again.",
        HttpStatus.Unauthorized
      );
    }

    // Everything checks out: rotate the refresh token
    const newRefreshToken = await generateRefreshToken({
      id: account.id,
      jti: uuidv4(),
    });

    // Revoke the old token and mark replacement
    await prisma.refreshToken.update({
      where: { id: storedToken.id },
      data: {
        revokedAt: new Date(),
        revokedReason: RevokedReason.ROTATED,
      },
    });

    // Create a fresh access token as before
    const accessToken = generateAccessToken({
      id: account.id,
      role: account.role,
      createdAt: account.createdAt,
      status: account.status,
      email: account.email,
    });

    logger.info(
      `Token refreshed for account ID: ${account.id}, name: ${account.name}`
    );

    return {
      account,
      accessToken,
      newRefreshToken,
    };
  }

  async logout(payload: LogoutPayload) {
    const { refreshToken } = payload;
    // Verify refresh token and extract payload.
    const decoded = verifyRefreshToken(refreshToken);

    // Revoke the refresh token by updating its record in the database
    await prisma.refreshToken.updateMany({
      where: { jti: decoded.jti, revokedAt: null },
      data: {
        revokedAt: new Date(),
        revokedReason: RevokedReason.ACCOUNT_LOGOUT,
      },
    });

    logger.info(`Refresh token revoked for logout: ${refreshToken}`);
    return;
  }

  async forgetPassword(payload: ForgetPasswordPayload) {
    const { email } = payload;
    const account = await prisma.account.findUnique({ where: { email } });

    // If no account found, return 404 (email does not exist)
    if (!account) {
      throw new APIError(
        "No account found with this email address.",
        HttpStatus.NotFound
      );
    }

    // If account has not verified their email, resend verification code and block forget password
    if (account.status === Status.UNVERIFIED) {
      await this.generateAndSendVerificationCode(
        "Verify your email",
        account.email
      );

      throw new APIError(
        "Please verify your email to continue",
        HttpStatus.Forbidden
      );
    }

    // If account is inactive, resend activation code and block forget password
    if (account.status === Status.INACTIVE) {
      await this.generateAndSendVerificationCode(
        "Activate your account",
        account.email
      );

      throw new APIError(
        "Your account is inactive. Please check your email to activate your account.",
        HttpStatus.Forbidden
      );
    }

    // If account is suspended, block forget password
    if (account.status === Status.SUSPENDED) {
      throw new APIError(
        "Your account has been suspended. Please contact support.",
        HttpStatus.Forbidden
      );
    }

    // Send reset password code
    await this.generateAndSendPasswordResetCode(
      "Your password reset code",
      email
    );

    logger.info(
      `Password reset code sent to account ID: ${account.id}, email: ${account.email}`
    );
    return;
  }

  async verifyPasswordResetCode(payload: VerifyPasswordResetCode) {
    const { code, email } = payload;

    // Find account with password reset fields only
    const existingaccount = await prisma.account.findUnique({
      where: { email },
      select: accountResetPasswordSelect,
    });

    // If no account found, return 404
    if (!existingaccount) {
      throw new APIError(
        "No account found with this email address.",
        HttpStatus.NotFound
      );
    }

    // If no reset code is stored, ask account to request a new one
    if (!existingaccount.passwordResetCode) {
      throw new APIError(
        "No reset code found. Please request a new password reset.",
        HttpStatus.BadRequest
      );
    }

    // Check if reset code has expired
    if (
      !existingaccount.passwordResetCodeExpiresAt ||
      existingaccount.passwordResetCodeExpiresAt <= new Date()
    ) {
      throw new APIError(
        "Your reset code has expired. Please request a new one.",
        HttpStatus.BadRequest
      );
    }

    // Validate provided code against stored hashed code
    const ok = await compareCode(code, existingaccount.passwordResetCode);
    if (!ok) {
      throw new APIError(
        "The reset code you entered is invalid. Please try again or request a new one.",
        HttpStatus.BadRequest
      );
    }

    // Generate reset token (JWT)
    const resetToken = await generateResetToken({
      accountId: existingaccount.id,
      purpose: "password-reset",
      jti: uuidv4(),
    });

    return { resetToken };
  }

  async resetPassword(payload: ResetPasswordPayload) {
    const { resetToken, newPassword } = payload;

    let decoded: ResetTokenPayload;

    try {
      decoded = await verifyResetToken(resetToken);
    } catch (err) {
      if (err instanceof TokenExpiredError) {
        throw new APIError("Invalid or expired token, please try again", 403);
      }
      throw err;
    }

    if (
      !decoded ||
      !decoded.accountId ||
      decoded.purpose !== "password-reset"
    ) {
      throw new APIError("Invalid reset token", HttpStatus.Unauthorized);
    }

    // Find account with password reset fields only
    const existingaccount = await prisma.account.findUnique({
      where: { id: decoded.accountId },
      select: accountResetPasswordSelect,
    });

    // If no account found, return 404
    if (!existingaccount) {
      throw new APIError(
        "No account found with this email address.",
        HttpStatus.NotFound
      );
    }

    // Look up the stored refresh-token record by jti
    const storedToken = await prisma.refreshToken.findUnique({
      where: { jti: decoded.jti },
    });

    // If token record doesn't exist or doesn't belong to account => invalid
    if (!storedToken || storedToken.accountId !== existingaccount.id) {
      throw new APIError("Invalid reset token", HttpStatus.Unauthorized);
    }

    // If token was already revoked -> possible reuse (token theft)
    if (storedToken.revokedReason) {
      // Revoke all active refresh tokens for this account as a precaution
      await prisma.refreshToken.updateMany({
        where: { accountId: existingaccount.id, revokedReason: null },
        data: {
          revokedReason: RevokedReason.TOKEN_REUSE_DETECTED,
          revokedAt: new Date(),
        },
      });

      throw new APIError(
        "Reset token has been revoked.",
        HttpStatus.Unauthorized
      );
    }

    // Check expiration of stored refresh token (defense-in-depth)
    if (storedToken.expiresAt && storedToken.expiresAt < new Date()) {
      // mark it revoked for clarity
      await prisma.refreshToken.update({
        where: { id: storedToken.id },
        data: { revokedAt: new Date(), revokedReason: RevokedReason.EXPIRED },
      });

      throw new APIError(
        "Reset token has been revoked.",
        HttpStatus.Unauthorized
      );
    }

    // Hash the new password before storing
    const hashedPassword = await hashPassword(newPassword);

    // Update account: clear reset fields, set new password, ensure ACTIVE status
    const account = await prisma.account.update({
      where: { id: decoded.accountId },
      data: {
        password: hashedPassword,
        status: Status.ACTIVE,
        passwordResetCode: null,
        passwordResetCodeExpiresAt: null,
      },
      select: accountSafeSelect,
    });

    if (!account) {
      throw new APIError(
        "Something went wrong while resetting your password. Please try again.",
        HttpStatus.InternalServerError
      );
    }

    // Revoke all previous refresh tokens for security after password change
    await prisma.refreshToken.updateMany({
      where: {
        accountId: account.id,
        revokedReason: null,
      },
      data: {
        revokedReason: RevokedReason.PASSWORD_CHANGE,
        revokedAt: new Date(),
      },
    });

    // Generate fresh tokens
    const accessToken = generateAccessToken({
      id: account.id,
      role: account.role,
      createdAt: account.createdAt,
      status: account.status,
      email: account.email,
    });
    const refreshToken = await generateRefreshToken({
      id: account.id,
      jti: uuidv4(),
    });

    await addEmailJob("passwordResetConfirmation", {
      to: account.email,
      subject: "Your password has been reset successfully",
      name: account.name,
    });

    logger.info(
      `Password successfully reset for account ID: ${account.id}, email: ${account.email}`
    );

    return { accessToken, refreshToken };
  }

  async handleGoogleCallback(payload: HandleGoogleCallbackPayload) {
    const { email } = payload;
    const account = await prisma.account.findUnique({
      where: { email },
      select: accountSafeSelect,
    });

    // Generate fresh tokens
    const accessToken = generateAccessToken({
      id: account!.id,
      role: account!.role,
      createdAt: account!.createdAt,
      status: account!.status,
      email: account!.email,
    });
    const refreshToken = await generateRefreshToken({
      id: account!.id,
      jti: uuidv4(),
    });

    return { accessToken, refreshToken, account };
  }
}

export default new AuthService();
