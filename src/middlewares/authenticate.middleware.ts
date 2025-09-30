import { RequestHandler, Request } from "express";

import APIError from "../utils/APIError";
import {
  verifyAccessToken,
  verifyRefreshToken,
} from "../modules/auth/token.service";
import prisma from "../config/prisma.config";
import { Status } from "@prisma/client";
import { accountSafeSelect } from "../modules/auth/auth.select";
import { Account } from "../modules/auth/auth.type";

const getTokenFromRequest = (req: Request): string | undefined => {
  if (
    !req.headers.authorization ||
    !req.headers.authorization.startsWith("Bearer ")
  )
    throw new APIError(
      "You are not logged in! please login to get access.",
      401
    );
  return req.headers.authorization.split(" ")[1];
};

export const authenticate: RequestHandler = async (req: Request, res, next) => {
  // Read token from reques
  const accessToken = getTokenFromRequest(req);
  if (!accessToken || accessToken === "null")
    throw new APIError(
      "You are not logged in! please login to get access.",
      401
    );

  // Verify access token and extract payload.
  const accessDecoded = verifyAccessToken(accessToken);
  if (!accessDecoded?.id) {
    throw new APIError("Invalid or expired access token.", 401);
  }

  // Fetch the account referenced in the token. We select a "safe" projection
  const account = await prisma.account.findUnique({
    where: { id: accessDecoded.id },
    select: accountSafeSelect,
  });

  if (!account) {
    throw new APIError("No account found for the provided token.", 401);
  }

  const { refreshToken } = req.cookies;

  // If there is no refresh token in the cookies, immediately reject the request
  if (!refreshToken) {
    throw new APIError("Invalid or expired refresh token.", 401);
  }

  // Verify refresh token and extract payload.
  const refreshDecoded = verifyRefreshToken(refreshToken);

  // Look up a matching refresh token record in the database that are not revoked
  const refreshTokenRecord = await prisma.refreshToken.findFirst({
    where: {
      revokedReason: null,
      jti: refreshDecoded.jti,
    },
  });

  // If no record is found, the token is either revoked
  if (!refreshTokenRecord) {
    throw new APIError("Invalid or expired refresh token.", 401);
  }

  // Check account status and return helpful, actionable messages
  if (account.status === Status.INACTIVE) {
    throw new APIError(
      "Account is inactive. Please contact support to reactivate your account.",
      403
    );
  }

  if (account.status === Status.SUSPENDED) {
    throw new APIError(
      "Account suspended. If you believe this is an error, please contact support.",
      403
    );
  }

  // Attach the safe account object to the request so downstream handlers can use it
  req.account = account as Account;
  next();
};
