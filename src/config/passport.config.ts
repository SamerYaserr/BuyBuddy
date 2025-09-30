import passport from "passport";
import crypto from "crypto";
import { Strategy as GoogleStrategy, Profile } from "passport-google-oauth20";

import prisma from "./prisma.config";
import env from "./env.config";
import { HttpStatus } from "../enums/httpStatus.enum";
import APIError from "../utils/APIError";
import { hashPassword } from "../utils/hash";
import { Status, Provider } from "@prisma/client";
import { Account } from "../modules/auth/auth.type";
import { accountSafeSelect } from "../modules/auth/auth.select";
import { sendAccountActivatedEmail } from "../services/email/send";
import logger from "./logger.config";

passport.use(
  new GoogleStrategy(
    {
      clientID: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      callbackURL: env.GOOGLE_CALLBACK_URL,
    },
    // typed callback: the `done` (cb) signature is (err, account?, info?)
    async (
      accessToken: string,
      refreshToken: string,
      profile: Profile,
      cb: (err: any, account?: Account | false) => void
    ) => {
      try {
        // Prefer profile._json.email_verified, fallback to profile.emails
        const email =
          (profile._json && (profile._json as any).email) ||
          profile.emails?.[0]?.value;
        const emailVerified =
          (profile._json && (profile._json as any).email_verified) ??
          profile.emails?.[0]?.verified ??
          false;

        if (!email) {
          return cb(
            new APIError(
              "Google profile does not contain an email.",
              HttpStatus.BadRequest
            ),
            false
          );
        }

        if (!emailVerified) {
          return cb(
            new APIError(
              "Your Google account email is not verified.",
              HttpStatus.Unauthorized
            ),
            false
          );
        }

        // Generate a secure random password (only to satisfy DB if password is required)
        const randomPassword = crypto.randomBytes(32).toString("hex");
        const hashedPassword = await hashPassword(randomPassword);

        const name = (
          profile.displayName ||
          (profile._json && (profile._json as any).name) ||
          "user"
        ).trim();
        const providerId = profile.id;

        // Try to find existing safe account
        const existingAccount = await prisma.account.findUnique({
          where: { email },
          select: accountSafeSelect,
        });

        if (existingAccount) {
          // If account suspended — bail out
          if (existingAccount.status === Status.SUSPENDED) {
            return cb(
              new APIError(
                "Your account has been suspended. Please contact support.",
                HttpStatus.Forbidden
              ),
              false
            );
          }

          // If the existing account was UNVERIFIED or INACTIVE but Google email is verified,
          // promote to ACTIVE and attach provider/providerId (keep other safe fields)
          if (existingAccount.status !== Status.ACTIVE) {
            await prisma.account.update({
              where: { email },
              data: {
                status: Status.ACTIVE,
                provider: Provider.GOOGLE,
                providerId,
                verificationCode: null,
                verificationCodeExpiresAt: null,
              },
            });

            // optionally notify account about activation
            try {
              await sendAccountActivatedEmail(email, {
                subject: "Activate your account",
                name: existingAccount.name,
              });
            } catch (e) {
              // don't fail the login if email sending fails; just log it
              logger.warn("Failed to send activation email:", e);
            }
          } else {
            // Ensure provider fields set for active account
            await prisma.account.update({
              where: { email },
              data: {
                provider: Provider.GOOGLE,
                providerId,
              },
            });
          }

          // Return the safe-selected account (re-fetch with select)
          const account = await prisma.account.findUnique({
            where: { email },
            select: accountSafeSelect,
          });

          return cb(null, account as Account);
        }

        // No existing account -> create (use select to avoid returning password)
        const created = await prisma.account.create({
          data: {
            name,
            email,
            password: hashedPassword,
            provider: Provider.GOOGLE,
            providerId,
            status: Status.ACTIVE,
          },
          select: accountSafeSelect,
        });

        return cb(null, created as Account);
      } catch (err) {
        // Passport expects the error to be passed to the callback, not thrown.
        logger.error("GoogleStrategy error:", err);
        return cb(
          err instanceof APIError
            ? err
            : new APIError(
                "Something went wrong while doing google auth",
                HttpStatus.InternalServerError
              ),
          false
        );
      }
    }
  )
);

export default passport;
