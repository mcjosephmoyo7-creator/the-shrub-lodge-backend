import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { supabase } from "./supabase.js";

const router = Router();
const missingTablesReported = new Set();
const publicContentKeys = new Set([
  "hero",
  "about",
  "services",
  "contact",
  "socialLinks",
  "testimonials",
  "footer",
]);

const contactSchema = z
  .object({
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().min(1).max(80),
    email: z.string().trim().email().max(200),
    message: z.string().trim().min(1).max(4000),
  })
  .strict();

function requireContactProxySecret(req, res, next) {
  const expected = process.env.CONTACT_API_PROXY_SECRET?.trim();
  const supplied = req.get("x-contact-proxy-secret") ?? "";
  const expectedBytes = Buffer.from(expected ?? "");
  const suppliedBytes = Buffer.from(supplied);

  if (!expected) {
    return res.status(503).json({ error: "Contact message storage is not configured." });
  }
  if (
    expectedBytes.length !== suppliedBytes.length ||
    !timingSafeEqual(expectedBytes, suppliedBytes)
  ) {
    return res.status(404).json({ error: "Not found." });
  }
  return next();
}

function setNoStore(_req, res, next) {
  res.setHeader("Cache-Control", "no-store");
  return next();
}

function databaseError(res, error, action) {
  console.error(`[public-api] Unable to ${action}:`, error.message);
  return res.status(500).json({ error: `Unable to ${action}.` });
}

function isMissingTable(error, table) {
  return (
    ["PGRST205", "42P01"].includes(error.code) &&
    error.message.includes(`public.${table}`)
  );
}

function warnMissingTable(table) {
  if (missingTablesReported.has(table)) return;
  missingTablesReported.add(table);
  console.warn(
    `[public-api] CMS table public.${table} is unavailable; serving the public fallback. Apply database/cms-schema.sql to enable CMS content.`,
  );
}

router.use(setNoStore);

router.get("/content", async (_req, res) => {
  const { data, error } = await supabase
    .from("site_content")
    .select("key, value")
    .in("key", [...publicContentKeys, "settings"]);

  if (error) {
    if (isMissingTable(error, "site_content")) {
      warnMissingTable("site_content");
      return res.status(200).json({
        content: {},
        settings: {
          site_title: "",
          logo_url: "",
          seo_title: "",
          seo_description: "",
        },
      });
    }
    return databaseError(res, error, "load public site content");
  }

  const content = {};
  let settings = {
    site_title: "",
    logo_url: "",
    seo_title: "",
    seo_description: "",
  };

  for (const row of data) {
    if (row.key === "settings" && row.value && typeof row.value === "object") {
      settings = {
        site_title:
          typeof row.value.site_title === "string" ? row.value.site_title : "",
        logo_url:
          typeof row.value.logo_url === "string" ? row.value.logo_url : "",
        seo_title:
          typeof row.value.seo_title === "string" ? row.value.seo_title : "",
        seo_description:
          typeof row.value.seo_description === "string"
            ? row.value.seo_description
            : "",
      };
    } else if (publicContentKeys.has(row.key)) {
      content[row.key] = row.value;
    }
  }

  return res.status(200).json({ content, settings });
});

router.get("/works", async (_req, res) => {
  const { data, error } = await supabase
    .from("works")
    .select(
      "id, slug, title, description, images, category, link, work_date, position",
    )
    .eq("published", true)
    .order("position", { ascending: true })
    .order("work_date", { ascending: false, nullsFirst: false });

  if (error) {
    if (isMissingTable(error, "works")) {
      warnMissingTable("works");
      return res.status(200).json({ works: [] });
    }
    return databaseError(res, error, "load public works");
  }
  return res.status(200).json({ works: data });
});

router.get("/works/:slug", async (req, res) => {
  const { data, error } = await supabase
    .from("works")
    .select(
      "id, slug, title, description, images, category, link, work_date, position",
    )
    .eq("slug", req.params.slug)
    .eq("published", true)
    .maybeSingle();

  if (error) {
    if (isMissingTable(error, "works")) {
      warnMissingTable("works");
      return res.status(404).json({ error: "Work not found." });
    }
    return databaseError(res, error, "load public work");
  }
  if (!data) return res.status(404).json({ error: "Work not found." });
  return res.status(200).json({ work: data });
});

router.get("/posts", async (_req, res) => {
  const now = new Date().toISOString();
  const columns =
    "id, slug, title, excerpt, content, cover_image, published_at, scheduled_for, created_at";
  const [publishedResult, scheduledResult] = await Promise.all([
    supabase
      .from("posts")
      .select(columns)
      .eq("status", "published")
      .order("published_at", { ascending: false }),
    supabase
      .from("posts")
      .select(columns)
      .eq("status", "scheduled")
      .lte("scheduled_for", now)
      .order("scheduled_for", { ascending: false }),
  ]);
  const failedQuery = publishedResult.error ?? scheduledResult.error;
  if (failedQuery) {
    if (isMissingTable(failedQuery, "posts")) {
      warnMissingTable("posts");
      return res.status(200).json({ posts: [] });
    }
    return databaseError(res, failedQuery, "load public posts");
  }

  const posts = [...(publishedResult.data ?? []), ...(scheduledResult.data ?? [])]
    .sort((left, right) => {
      const leftDate = left.published_at ?? left.scheduled_for ?? left.created_at;
      const rightDate = right.published_at ?? right.scheduled_for ?? right.created_at;
      return Date.parse(rightDate) - Date.parse(leftDate);
    });

  return res.status(200).json({ posts });
});

router.get("/posts/:slug", async (req, res) => {
  const columns =
    "id, slug, title, excerpt, content, cover_image, status, published_at, scheduled_for, created_at";
  const { data: publishedPost, error: publishedError } = await supabase
    .from("posts")
    .select(columns)
    .eq("slug", req.params.slug)
    .eq("status", "published")
    .maybeSingle();
  if (publishedError) {
    if (isMissingTable(publishedError, "posts")) {
      warnMissingTable("posts");
      return res.status(404).json({ error: "Post not found." });
    }
    return databaseError(res, publishedError, "load public post");
  }
  if (publishedPost) return res.status(200).json({ post: publishedPost });

  const { data: scheduledPost, error: scheduledError } = await supabase
    .from("posts")
    .select(columns)
    .eq("slug", req.params.slug)
    .eq("status", "scheduled")
    .lte("scheduled_for", new Date().toISOString())
    .maybeSingle();
  if (scheduledError) {
    if (isMissingTable(scheduledError, "posts")) {
      warnMissingTable("posts");
      return res.status(404).json({ error: "Post not found." });
    }
    return databaseError(res, scheduledError, "load public post");
  }
  if (!scheduledPost) return res.status(404).json({ error: "Post not found." });
  return res.status(200).json({ post: scheduledPost });
});

router.post("/contact", requireContactProxySecret, async (req, res) => {
  const parsed = contactSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Check your details and try again." });
  }

  const { data, error } = await supabase
    .from("contact_messages")
    .insert({
      first_name: parsed.data.firstName,
      last_name: parsed.data.lastName,
      email: parsed.data.email,
      message: parsed.data.message,
    })
    .select("id, created_at")
    .single();

  if (error) return databaseError(res, error, "store contact message");
  return res.status(201).json({ message: data });
});

export default router;
