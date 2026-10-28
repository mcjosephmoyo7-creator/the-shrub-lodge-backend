import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import bcrypt from "bcryptjs";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { hashPassword, verifyPassword } from "./passwords.js";
import { supabase } from "./supabase.js";

const router = Router();
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const ABSOLUTE_TIMEOUT_MS = 12 * 60 * 60 * 1000;
const DUMMY_PASSWORD_HASH = await bcrypt.hash(
  randomBytes(32).toString("hex"),
  12,
);

const loginSchema = z
  .object({
    email: z.string().trim().email().max(254).transform((email) => email.toLowerCase()),
    password: z.string().min(1),
  })
  .strict();

const passwordChangeSchema = z
  .object({
    currentPassword: z
      .string()
      .min(1),
    newPassword: z.string().min(1),
  })
  .strict();

const firstAdminSchema = z
  .object({
    email: z.string().trim().email().max(254).transform((email) => email.toLowerCase()),
    password: z.string().min(1),
  })
  .strict();

const passwordResetRequestSchema = z
  .object({
    email: z.string().trim().email().max(254).transform((email) => email.toLowerCase()),
  })
  .strict();

const passwordResetSchema = z
  .object({
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    password: z.string().min(1),
  })
  .strict();

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function requireProxySecret(req, res, next) {
  const expected = process.env.ADMIN_API_PROXY_SECRET?.trim();
  const supplied = req.get("x-admin-proxy-secret") ?? "";

  if (!expected) {
    return res.status(503).json({ error: "Admin API is not configured." });
  }

  if (!constantTimeEqual(expected, supplied)) {
    return res.status(404).json({ error: "Not found." });
  }

  next();
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Please try again later." },
});
const passwordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many password changes. Please try again later." },
});
const setupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many setup attempts. Please try again later." },
});
const resetRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many reset requests. Please try again later." },
});
const resetPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many reset attempts. Please try again later." },
});

router.use(requireProxySecret);
router.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

router.get("/auth/setup-status", async (_req, res) => {
  const { count, error } = await supabase
    .from("admin_users")
    .select("id", { count: "exact", head: true });

  if (error) {
    console.error("[admin-auth] Admin setup status lookup failed:", error.message);
    return res.status(500).json({ error: "Unable to check admin setup status." });
  }

  return res.status(200).json({ setupRequired: count === 0 });
});

router.post("/auth/setup", setupLimiter, async (req, res) => {
  const parsed = firstAdminSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Enter a valid email and password.",
    });
  }

  const passwordHash = await hashPassword(parsed.data.password);
  const { data: created, error } = await supabase.rpc("create_first_admin", {
    p_email: parsed.data.email,
    p_password_hash: passwordHash,
  });

  if (error) {
    console.error("[admin-auth] First-admin creation failed:", error.message);
    return res.status(500).json({
      error: "Unable to create the owner account. Verify the CMS schema has been applied.",
    });
  }
  if (!created) {
    return res.status(409).json({ error: "An admin account already exists. Please sign in." });
  }

  return res.status(201).json({ ok: true });
});

router.post("/auth/password-reset/request", resetRequestLimiter, async (req, res) => {
  const parsed = passwordResetRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }

  const resendKey = process.env.RESEND_API_KEY?.trim();
  if (!resendKey) {
    console.error("[admin-auth] Password reset email is not configured: RESEND_API_KEY is missing.");
    return res.status(503).json({
      error: "Password reset email is not configured. Contact the site owner.",
    });
  }

  const genericResponse = {
    message: "If an admin account matches that email, a password reset link will be sent.",
  };
  const { data: user, error: lookupError } = await supabase
    .from("admin_users")
    .select("id, email")
    .eq("email", parsed.data.email)
    .eq("role", "admin")
    .maybeSingle();

  if (lookupError) {
    console.error("[admin-auth] Password reset account lookup failed:", lookupError.message);
    return res.status(500).json({ error: "Unable to process the password reset request." });
  }
  if (!user) return res.status(200).json(genericResponse);

  const token = randomBytes(32).toString("base64url");
  const tokenHash = hash(token);
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const { error: deleteError } = await supabase
    .from("admin_password_resets")
    .delete()
    .eq("user_id", user.id);
  if (deleteError) {
    console.error("[admin-auth] Previous password reset cleanup failed:", deleteError.message);
    return res.status(500).json({ error: "Unable to process the password reset request." });
  }

  const { error: insertError } = await supabase
    .from("admin_password_resets")
    .insert({ token_hash: tokenHash, user_id: user.id, expires_at: expiresAt });
  if (insertError) {
    console.error("[admin-auth] Password reset token creation failed:", insertError.message);
    return res.status(500).json({ error: "Unable to process the password reset request." });
  }

  const frontendOrigin = (process.env.FRONTEND_URL || "http://localhost:3000")
    .split(",")[0]
    .trim()
    .replace(/\/+$/, "");
  const resetUrl = new URL("/lodge-owner-console/reset-password", frontendOrigin);
  resetUrl.searchParams.set("token", token);
  const from =
    process.env.ADMIN_RESET_FROM_EMAIL?.trim() ||
    process.env.CONTACT_FROM_EMAIL?.trim() ||
    "The Shrub Lodge <onboarding@resend.dev>";

  let emailSent = false;
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: user.email,
        subject: "Reset your Shrub Lodge admin password",
        text: [
          "A password reset was requested for your Shrub Lodge admin account.",
          "",
          `Use this link within 30 minutes: ${resetUrl}`,
          "",
          "If you did not request this, you can ignore this email.",
        ].join("\n"),
        html: `<p>A password reset was requested for your Shrub Lodge admin account.</p><p><a href="${resetUrl.toString()}">Reset your password</a></p><p>This link expires in 30 minutes. If you did not request this, you can ignore this email.</p>`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    emailSent = response.ok;
    if (!response.ok) {
      console.error(
        "[admin-auth] Password reset email provider returned:",
        response.status,
      );
    }
  } catch (error) {
    console.error("[admin-auth] Password reset email delivery failed:", error);
  }

  if (!emailSent) {
    const { error: cleanupError } = await supabase
      .from("admin_password_resets")
      .delete()
      .eq("token_hash", tokenHash);
    if (cleanupError) {
      console.error("[admin-auth] Failed to remove undelivered password reset token:", cleanupError.message);
    }
  }

  return res.status(200).json(genericResponse);
});

router.post("/auth/password-reset/confirm", resetPasswordLimiter, async (req, res) => {
  const parsed = passwordResetSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Enter a valid reset link and new password." });
  }

  const passwordHash = await hashPassword(parsed.data.password);
  const { data: reset, error } = await supabase.rpc(
    "consume_admin_password_reset",
    {
      p_token_hash: hash(parsed.data.token),
      p_password_hash: passwordHash,
    },
  );
  if (error) {
    console.error("[admin-auth] Password reset confirmation failed:", error.message);
    return res.status(500).json({
      error: "Unable to reset the password. Verify the CMS schema has been applied.",
    });
  }
  if (!reset) {
    return res.status(400).json({
      error: "This password reset link is invalid or expired. Request a new one.",
    });
  }

  return res.status(200).json({ ok: true });
});

router.post("/auth/login", loginLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Enter a valid email and password." });
  }

  const { email, password } = parsed.data;
  const { data: user, error: lookupError } = await supabase
    .from("admin_users")
    .select("id, email, password_hash, role, locked_until")
    .eq("email", email)
    .maybeSingle();

  if (lookupError) {
    console.error("[admin-auth] User lookup failed:", lookupError.message);
    return res.status(500).json({ error: "Unable to sign in right now." });
  }

  const passwordMatches = await verifyPassword(
    password,
    user?.password_hash ?? DUMMY_PASSWORD_HASH,
  );
  const locked =
    user?.locked_until && Date.parse(user.locked_until) > Date.now();

  if (!user || user.role !== "admin" || locked || !passwordMatches) {
    if (user && user.role === "admin" && !locked) {
      const { error: updateError } = await supabase.rpc(
        "record_admin_login_failure",
        { p_user_id: user.id },
      );

      if (updateError) {
        console.error("[admin-auth] Failed to record login failure:", updateError.message);
        return res.status(500).json({ error: "Unable to sign in right now." });
      }
    }

    return res.status(401).json({ error: "Invalid email or password." });
  }

  const now = Date.now();
  const absoluteExpiresAt = now + ABSOLUTE_TIMEOUT_MS;
  const idleExpiresAt = Math.min(now + IDLE_TIMEOUT_MS, absoluteExpiresAt);
  const token = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");

  const { error: resetError } = await supabase
    .from("admin_users")
    .update({ failed_login_count: 0, locked_until: null })
    .eq("id", user.id);

  if (resetError) {
    console.error("[admin-auth] Failed to reset login failures:", resetError.message);
    return res.status(500).json({ error: "Unable to sign in right now." });
  }

  const { error: sessionError } = await supabase.from("admin_sessions").insert({
    token_hash: hash(token),
    csrf_hash: hash(csrfToken),
    user_id: user.id,
    expires_at: new Date(idleExpiresAt).toISOString(),
    absolute_expires_at: new Date(absoluteExpiresAt).toISOString(),
  });

  if (sessionError) {
    console.error("[admin-auth] Failed to create session:", sessionError.message);
    return res.status(500).json({ error: "Unable to sign in right now." });
  }

  return res.status(200).json({
    token,
    csrfToken,
    expiresAt: new Date(idleExpiresAt).toISOString(),
    user: { id: user.id, email: user.email, role: user.role },
  });
});

export async function requireAdminSession(req, res, next) {
  const authorization = req.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization);
  if (!match) {
    return res.status(401).json({ error: "Authentication required." });
  }

  const tokenHash = hash(match[1]);
  const now = Date.now();
  const { data: session, error: sessionError } = await supabase
    .from("admin_sessions")
    .select("token_hash, csrf_hash, user_id, absolute_expires_at")
    .eq("token_hash", tokenHash)
    .gt("expires_at", new Date(now).toISOString())
    .gt("absolute_expires_at", new Date(now).toISOString())
    .maybeSingle();

  if (sessionError) {
    console.error("[admin-auth] Session lookup failed:", sessionError.message);
    return res.status(500).json({ error: "Unable to verify your session." });
  }
  if (!session) {
    return res.status(401).json({ error: "Authentication required." });
  }

  const { data: user, error: userError } = await supabase
    .from("admin_users")
    .select("id, email, role")
    .eq("id", session.user_id)
    .maybeSingle();

  if (userError) {
    console.error("[admin-auth] Admin lookup failed:", userError.message);
    return res.status(500).json({ error: "Unable to verify your session." });
  }
  if (!user || user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required." });
  }

  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    const csrfToken = req.get("x-csrf-token") ?? "";
    if (
      !csrfToken ||
      !constantTimeEqual(hash(csrfToken), session.csrf_hash)
    ) {
      return res.status(403).json({ error: "CSRF validation failed." });
    }
  }

  const idleExpiresAt = Math.min(
    now + IDLE_TIMEOUT_MS,
    Date.parse(session.absolute_expires_at),
  );
  const { error: touchError } = await supabase
    .from("admin_sessions")
    .update({
      last_seen_at: new Date(now).toISOString(),
      expires_at: new Date(idleExpiresAt).toISOString(),
    })
    .eq("token_hash", tokenHash);

  if (touchError) {
    console.error("[admin-auth] Session refresh failed:", touchError.message);
    return res.status(500).json({ error: "Unable to refresh your session." });
  }

  req.admin = { id: user.id, email: user.email, role: user.role };
  req.adminSession = { tokenHash, csrfHash: session.csrf_hash };
  next();
}

router.get("/auth/session", requireAdminSession, (req, res) => {
  res.status(200).json({ user: req.admin });
});

router.post("/auth/logout", requireAdminSession, async (req, res) => {
  const { error } = await supabase
    .from("admin_sessions")
    .delete()
    .eq("token_hash", req.adminSession.tokenHash);

  if (error) {
    console.error("[admin-auth] Session revocation failed:", error.message);
    return res.status(500).json({ error: "Unable to log out right now." });
  }

  return res.status(200).json({ ok: true });
});

router.patch(
  "/auth/password",
  requireAdminSession,
  passwordLimiter,
  async (req, res) => {
    const parsed = passwordChangeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Enter a new password.",
      });
    }

    const { data: user, error: lookupError } = await supabase
      .from("admin_users")
      .select("password_hash")
      .eq("id", req.admin.id)
      .single();

    if (lookupError) {
      console.error("[admin-auth] Password lookup failed:", lookupError.message);
      return res.status(500).json({ error: "Unable to update your password." });
    }

    const currentPasswordMatches = await verifyPassword(
      parsed.data.currentPassword,
      user.password_hash,
    );
    if (!currentPasswordMatches) {
      return res.status(401).json({ error: "Current password is incorrect." });
    }

    const passwordHash = await hashPassword(parsed.data.newPassword);
    const { error: updateError } = await supabase
      .from("admin_users")
      .update({
        password_hash: passwordHash,
        failed_login_count: 0,
        locked_until: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", req.admin.id);

    if (updateError) {
      console.error("[admin-auth] Password update failed:", updateError.message);
      return res.status(500).json({ error: "Unable to update your password." });
    }

    const { error: revokeError } = await supabase
      .from("admin_sessions")
      .delete()
      .eq("user_id", req.admin.id);

    if (revokeError) {
      console.error(
        "[admin-auth] Session revocation failed after password update:",
        revokeError.message,
      );
      return res.status(500).json({
        error:
          "Password changed, but sessions could not be revoked. Please sign out everywhere.",
      });
    }

    const { error: activityError } = await supabase.from("activity_logs").insert({
      actor_id: req.admin.id,
      action: "changed password",
      entity_type: "admin_account",
      entity_id: req.admin.id,
      details: {},
    });
    if (activityError) {
      console.error(
        "[admin-auth] Password activity log failed:",
        activityError.message,
      );
      return res.status(500).json({
        error:
          "Password changed and sessions revoked, but the activity entry could not be recorded.",
      });
    }

    return res.status(200).json({ ok: true });
  },
);

export default router;
