import { randomUUID } from "node:crypto";
import { Router } from "express";
import multer from "multer";
import { fileTypeFromBuffer } from "file-type";
import { z } from "zod";
import { requireAdminSession, requireProxySecret } from "./admin-auth.js";
import { supabase } from "./supabase.js";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    const accepted = new Set([
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/avif",
    ]);
    callback(
      accepted.has(file.mimetype)
        ? null
        : new Error("Upload a JPEG, PNG, WebP, or AVIF image."),
      accepted.has(file.mimetype),
    );
  },
});

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const uuidSchema = z.string().uuid();
const httpUrlSchema = z
  .string()
  .url()
  .refine((value) => ["http:", "https:"].includes(new URL(value).protocol));
const optionalHttpUrlSchema = z.union([
  httpUrlSchema,
  z.literal(""),
]);

function containsUnsafeUrl(value, key = "") {
  if (typeof value === "string" && /(url|href|link|image|logo|src)$/i.test(key)) {
    if (!value) return false;
    try {
      return !["http:", "https:"].includes(new URL(value).protocol);
    } catch {
      return true;
    }
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsUnsafeUrl(entry, key));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).some(([childKey, childValue]) =>
      containsUnsafeUrl(childValue, childKey),
    );
  }
  return false;
}

const workSchema = z
  .object({
    slug: z.string().trim().regex(slugPattern).max(120),
    title: z.string().trim().min(1).max(200),
    description: z.string().max(12000).default(""),
    images: z.array(httpUrlSchema).max(20).default([]),
    category: z.string().trim().min(1).max(100),
    link: optionalHttpUrlSchema.nullable().optional(),
    work_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((value) => {
        const date = new Date(`${value}T00:00:00.000Z`);
        return (
          !Number.isNaN(date.getTime()) &&
          date.toISOString().slice(0, 10) === value
        );
      })
      .nullable()
      .optional(),
    position: z.number().int().min(-100000).max(100000).default(0),
    published: z.boolean().default(false),
  })
  .strict();

const postSchema = z
  .object({
    slug: z.string().trim().regex(slugPattern).max(120),
    title: z.string().trim().min(1).max(200),
    excerpt: z.string().max(1000).default(""),
    content: z.string().max(50000).default(""),
    cover_image: httpUrlSchema.nullable().optional(),
    status: z.enum(["draft", "scheduled", "published"]).default("draft"),
    scheduled_for: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();

const settingsSchema = z
  .object({
    site_title: z.string().trim().min(1).max(120),
    logo_url: optionalHttpUrlSchema.default(""),
    seo_title: z.string().trim().max(200).default(""),
    seo_description: z.string().trim().max(500).default(""),
  })
  .strict();

const contentKeySchema = z.enum([
  "hero",
  "about",
  "services",
  "contact",
  "socialLinks",
  "testimonials",
  "footer",
]);

const contentValueSchema = z.object({ value: z.unknown() }).strict();
const reorderSchema = z
  .object({
    ids: z.array(uuidSchema).min(1).max(500),
  })
  .strict();
const messageReadSchema = z.object({ read: z.boolean() }).strict();
const mediaAltSchema = z
  .object({ alt_text: z.string().trim().max(300) })
  .strict();

router.use(requireProxySecret);
router.use(requireAdminSession);
router.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

async function writeActivity(req, action, entityType, entityId, details = {}) {
  const { error } = await supabase.from("activity_logs").insert({
    actor_id: req.admin.id,
    action,
    entity_type: entityType,
    entity_id: entityId ? String(entityId) : null,
    details,
  });

  if (error) {
    console.error("[admin-api] Activity log write failed:", error.message);
    return false;
  }
  return true;
}

function respondAfterMutation(res, logged, payload, status = 200) {
  if (!logged) {
    return res.status(500).json({
      error: "The change was saved, but its activity entry could not be recorded.",
    });
  }
  return res.status(status).json(payload);
}

function databaseError(res, error, action) {
  if (error.code === "23505") {
    return res.status(409).json({ error: "That slug or item already exists." });
  }
  console.error(`[admin-api] ${action} failed:`, error.message);
  return res.status(500).json({ error: `Unable to ${action}.` });
}

router.get("/overview", async (_req, res) => {
  const [worksResult, postsResult, messagesResult, activityResult] =
    await Promise.all([
      supabase.from("works").select("id", { count: "exact", head: true }),
      supabase.from("posts").select("id", { count: "exact", head: true }),
      supabase
        .from("contact_messages")
        .select("id", { count: "exact", head: true })
        .is("read_at", null),
      supabase
        .from("activity_logs")
        .select("id, action, entity_type, entity_id, details, created_at")
        .order("created_at", { ascending: false })
        .limit(8),
    ]);

  const failedQuery = [
    worksResult.error,
    postsResult.error,
    messagesResult.error,
    activityResult.error,
  ].find(Boolean);
  if (failedQuery) {
    console.error("[admin-api] Overview query failed:", failedQuery.message);
    return res.status(500).json({ error: "Unable to load dashboard overview." });
  }

  return res.status(200).json({
    totalWorks: worksResult.count ?? 0,
    totalPosts: postsResult.count ?? 0,
    unreadMessages: messagesResult.count ?? 0,
    visitorStatsAvailable: false,
    recentActivity: activityResult.data,
  });
});

router.get("/works", async (_req, res) => {
  const { data, error } = await supabase
    .from("works")
    .select("*")
    .order("position", { ascending: true })
    .order("created_at", { ascending: false });

  if (error) return databaseError(res, error, "load works");
  return res.status(200).json({ works: data });
});

router.post("/works", async (req, res) => {
  const parsed = workSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Check the work details and try again." });
  }

  const { data, error } = await supabase
    .from("works")
    .insert(parsed.data)
    .select("*")
    .single();

  if (error) return databaseError(res, error, "create work");
  const logged = await writeActivity(req, "created", "work", data.id, {
    title: data.title,
  });
  return respondAfterMutation(res, logged, { work: data }, 201);
});

router.patch("/works/order", async (req, res) => {
  const parsed = reorderSchema.safeParse(req.body);
  if (!parsed.success || new Set(parsed.data.ids).size !== parsed.data.ids.length) {
    return res.status(400).json({ error: "Provide a unique ordered list of work IDs." });
  }

  const order = parsed.data.ids.map((id, position) => ({ id, position }));
  const { error } = await supabase.from("works").upsert(order, { onConflict: "id" });
  if (error) return databaseError(res, error, "reorder works");

  const logged = await writeActivity(req, "reordered", "works", null, {
    count: order.length,
  });
  return respondAfterMutation(res, logged, { ok: true });
});

router.put("/works/:id", async (req, res) => {
  const id = uuidSchema.safeParse(req.params.id);
  const parsed = workSchema.safeParse(req.body);
  if (!id.success || !parsed.success) {
    return res.status(400).json({ error: "Check the work details and try again." });
  }

  const { data, error } = await supabase
    .from("works")
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq("id", id.data)
    .select("*")
    .maybeSingle();

  if (error) return databaseError(res, error, "update work");
  if (!data) return res.status(404).json({ error: "Work not found." });
  const logged = await writeActivity(req, "updated", "work", data.id, {
    title: data.title,
  });
  return respondAfterMutation(res, logged, { work: data });
});

router.delete("/works/:id", async (req, res) => {
  const id = uuidSchema.safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ error: "Invalid work ID." });

  const { data, error } = await supabase
    .from("works")
    .delete()
    .eq("id", id.data)
    .select("id, title")
    .maybeSingle();

  if (error) return databaseError(res, error, "delete work");
  if (!data) return res.status(404).json({ error: "Work not found." });
  const logged = await writeActivity(req, "deleted", "work", data.id, {
    title: data.title,
  });
  return respondAfterMutation(res, logged, { ok: true });
});

router.get("/content", async (_req, res) => {
  const { data, error } = await supabase
    .from("site_content")
    .select("key, value, updated_at")
    .order("key", { ascending: true });

  if (error) return databaseError(res, error, "load site content");
  return res.status(200).json({
    content: Object.fromEntries(data.map((row) => [row.key, row.value])),
    updatedAt: Object.fromEntries(data.map((row) => [row.key, row.updated_at])),
  });
});

router.put("/content/:key", async (req, res) => {
  const key = contentKeySchema.safeParse(req.params.key);
  const parsed = contentValueSchema.safeParse(req.body);
  if (!key.success || !parsed.success) {
    return res.status(400).json({ error: "Invalid site content." });
  }

  const serialized = JSON.stringify(parsed.data.value);
  if (containsUnsafeUrl(parsed.data.value)) {
    return res.status(400).json({
      error: "Links and images must use a valid HTTP or HTTPS URL.",
    });
  }
  if (!serialized || Buffer.byteLength(serialized, "utf8") > 50000) {
    return res.status(413).json({ error: "Content must be smaller than 50 KB." });
  }

  const { data, error } = await supabase
    .from("site_content")
    .upsert(
      {
        key: key.data,
        value: parsed.data.value,
        updated_by: req.admin.id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" },
    )
    .select("key, value, updated_at")
    .single();

  if (error) return databaseError(res, error, "save site content");
  const logged = await writeActivity(req, "updated", "site_content", data.key, {
    key: data.key,
  });
  return respondAfterMutation(res, logged, { item: data });
});

router.get("/posts", async (_req, res) => {
  const { data, error } = await supabase
    .from("posts")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) return databaseError(res, error, "load posts");
  return res.status(200).json({ posts: data });
});

router.post("/posts", async (req, res) => {
  const parsed = postSchema.safeParse(req.body);
  if (
    !parsed.success ||
    (parsed.data.status === "scheduled" && !parsed.data.scheduled_for)
  ) {
    return res.status(400).json({ error: "Check the post details and schedule." });
  }

  const { data, error } = await supabase
    .from("posts")
    .insert({
      ...parsed.data,
      published_at:
        parsed.data.status === "published" ? new Date().toISOString() : null,
    })
    .select("*")
    .single();

  if (error) return databaseError(res, error, "create post");
  const logged = await writeActivity(req, "created", "post", data.id, {
    title: data.title,
    status: data.status,
  });
  return respondAfterMutation(res, logged, { post: data }, 201);
});

router.put("/posts/:id", async (req, res) => {
  const id = uuidSchema.safeParse(req.params.id);
  const parsed = postSchema.safeParse(req.body);
  if (
    !id.success ||
    !parsed.success ||
    (parsed.data.status === "scheduled" && !parsed.data.scheduled_for)
  ) {
    return res.status(400).json({ error: "Check the post details and schedule." });
  }

  const { data: current, error: currentError } = await supabase
    .from("posts")
    .select("published_at")
    .eq("id", id.data)
    .maybeSingle();
  if (currentError) return databaseError(res, currentError, "load post");
  if (!current) return res.status(404).json({ error: "Post not found." });

  const { data, error } = await supabase
    .from("posts")
    .update({
      ...parsed.data,
      published_at:
        parsed.data.status === "published"
          ? current.published_at ?? new Date().toISOString()
          : null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id.data)
    .select("*")
    .single();

  if (error) return databaseError(res, error, "update post");
  const logged = await writeActivity(req, "updated", "post", data.id, {
    title: data.title,
    status: data.status,
  });
  return respondAfterMutation(res, logged, { post: data });
});

router.delete("/posts/:id", async (req, res) => {
  const id = uuidSchema.safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ error: "Invalid post ID." });

  const { data, error } = await supabase
    .from("posts")
    .delete()
    .eq("id", id.data)
    .select("id, title")
    .maybeSingle();
  if (error) return databaseError(res, error, "delete post");
  if (!data) return res.status(404).json({ error: "Post not found." });

  const logged = await writeActivity(req, "deleted", "post", data.id, {
    title: data.title,
  });
  return respondAfterMutation(res, logged, { ok: true });
});

router.get("/media", async (_req, res) => {
  const { data, error } = await supabase
    .from("media_assets")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) return databaseError(res, error, "load media");
  return res.status(200).json({ media: data });
});

router.post("/media", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Choose an image to upload." });
  }

  const altText = z.string().trim().max(300).safeParse(req.body?.alt_text ?? "");
  if (!altText.success) {
    return res.status(400).json({ error: "Alternative text must be 300 characters or fewer." });
  }

  const detected = await fileTypeFromBuffer(req.file.buffer);
  const acceptedTypes = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/avif",
  ]);
  if (!detected || !acceptedTypes.has(detected.mime)) {
    return res.status(400).json({ error: "The uploaded file is not a supported image." });
  }

  const storagePath = `uploads/${randomUUID()}.${detected.ext}`;
  const { error: uploadError } = await supabase.storage
    .from("site-media")
    .upload(storagePath, req.file.buffer, {
      contentType: detected.mime,
      upsert: false,
    });
  if (uploadError) {
    console.error("[admin-api] Media upload failed:", uploadError.message);
    return res.status(502).json({ error: "Unable to store the uploaded image." });
  }

  const { data: publicUrl } = supabase.storage
    .from("site-media")
    .getPublicUrl(storagePath);
  const { data, error } = await supabase
    .from("media_assets")
    .insert({
      storage_path: storagePath,
      public_url: publicUrl.publicUrl,
      file_name: req.file.originalname.slice(0, 255),
      mime_type: detected.mime,
      byte_size: req.file.size,
      alt_text: altText.data,
      uploaded_by: req.admin.id,
    })
    .select("*")
    .single();

  if (error) {
    const { error: cleanupError } = await supabase.storage
      .from("site-media")
      .remove([storagePath]);
    if (cleanupError) {
      console.error("[admin-api] Failed to clean up unrecorded upload:", cleanupError.message);
    }
    return databaseError(res, error, "record uploaded media");
  }

  const logged = await writeActivity(req, "uploaded", "media", data.id, {
    file_name: data.file_name,
  });
  return respondAfterMutation(res, logged, { media: data }, 201);
});

router.patch("/media/:id", async (req, res) => {
  const id = uuidSchema.safeParse(req.params.id);
  const parsed = mediaAltSchema.safeParse(req.body);
  if (!id.success || !parsed.success) {
    return res.status(400).json({ error: "Check the image description." });
  }

  const { data, error } = await supabase
    .from("media_assets")
    .update({ alt_text: parsed.data.alt_text })
    .eq("id", id.data)
    .select("*")
    .maybeSingle();
  if (error) return databaseError(res, error, "update media");
  if (!data) return res.status(404).json({ error: "Image not found." });

  const logged = await writeActivity(req, "updated", "media", data.id, {
    file_name: data.file_name,
  });
  return respondAfterMutation(res, logged, { media: data });
});

router.delete("/media/:id", async (req, res) => {
  const id = uuidSchema.safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ error: "Invalid media ID." });

  const { data: asset, error: lookupError } = await supabase
    .from("media_assets")
    .select("id, storage_path, file_name")
    .eq("id", id.data)
    .maybeSingle();
  if (lookupError) return databaseError(res, lookupError, "load media");
  if (!asset) return res.status(404).json({ error: "Image not found." });

  const { error: storageError } = await supabase.storage
    .from("site-media")
    .remove([asset.storage_path]);
  if (storageError) {
    console.error("[admin-api] Media removal failed:", storageError.message);
    return res.status(502).json({ error: "Unable to delete the stored image." });
  }

  const { error } = await supabase.from("media_assets").delete().eq("id", id.data);
  if (error) return databaseError(res, error, "delete media record");

  const logged = await writeActivity(req, "deleted", "media", asset.id, {
    file_name: asset.file_name,
  });
  return respondAfterMutation(res, logged, { ok: true });
});

router.get("/messages", async (_req, res) => {
  const { data, error } = await supabase
    .from("contact_messages")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) return databaseError(res, error, "load messages");
  return res.status(200).json({ messages: data });
});

router.patch("/messages/:id", async (req, res) => {
  const id = uuidSchema.safeParse(req.params.id);
  const parsed = messageReadSchema.safeParse(req.body);
  if (!id.success || !parsed.success) {
    return res.status(400).json({ error: "Invalid message update." });
  }

  const { data, error } = await supabase
    .from("contact_messages")
    .update({
      read_at: parsed.data.read ? new Date().toISOString() : null,
    })
    .eq("id", id.data)
    .select("id, first_name, last_name, email, message, read_at, created_at")
    .maybeSingle();
  if (error) return databaseError(res, error, "update message");
  if (!data) return res.status(404).json({ error: "Message not found." });

  const logged = await writeActivity(req, "updated", "message", data.id, {
    read: parsed.data.read,
  });
  return respondAfterMutation(res, logged, { message: data });
});

router.get("/settings", async (_req, res) => {
  const { data, error } = await supabase
    .from("site_content")
    .select("value")
    .eq("key", "settings")
    .maybeSingle();
  if (error) return databaseError(res, error, "load settings");

  return res.status(200).json({
    settings: data?.value ?? {
      site_title: "The Shrub Lodge",
      logo_url: "",
      seo_title: "",
      seo_description: "",
    },
  });
});

router.put("/settings", async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Check the site settings and try again." });
  }

  const { data, error } = await supabase
    .from("site_content")
    .upsert(
      {
        key: "settings",
        value: parsed.data,
        updated_by: req.admin.id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" },
    )
    .select("value")
    .single();
  if (error) return databaseError(res, error, "save settings");

  const logged = await writeActivity(req, "updated", "settings", "settings", {
    site_title: parsed.data.site_title,
  });
  return respondAfterMutation(res, logged, { settings: data.value });
});

router.get("/activity", async (_req, res) => {
  const { data, error } = await supabase
    .from("activity_logs")
    .select("id, action, entity_type, entity_id, details, created_at")
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) return databaseError(res, error, "load activity log");
  return res.status(200).json({ activity: data });
});

router.use((error, _req, res, next) => {
  if (error instanceof multer.MulterError) {
    const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    return res.status(status).json({
      error:
        error.code === "LIMIT_FILE_SIZE"
          ? "Images must be 10 MB or smaller."
          : "Upload one image at a time.",
    });
  }
  if (error.message === "Upload a JPEG, PNG, WebP, or AVIF image.") {
    return res.status(400).json({ error: error.message });
  }
  return next(error);
});

export default router;
