
import "./env.js";
import express from "express";
import cors from "cors";
import { supabase } from "./supabase.js";
import adminAuth from "./admin-auth.js";
import adminApi from "./admin-api.js";
import publicApi from "./public-api.js";

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
// FRONTEND_URL can hold several comma-separated origins (e.g. local dev,
// the Vercel production domain, and preview URLs).
const allowedOrigins = (process.env.FRONTEND_URL || "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({ origin: allowedOrigins }));

app.use(express.json({ limit: "1mb" }));

app.use("/api/public", publicApi);

// Admin requests are available only to the same-origin frontend proxy. The
// proxy secret is server-side and must never be exposed to browser code.
app.use("/api/admin", adminAuth);
app.use("/api/admin", adminApi);

// Home route
app.get("/", (req, res) => {
  res.json({
    message: "The Shrub Lodge API is running!",
  });
});

// Health-check route
app.get("/api/health", (req, res) => {
  res.json({
    status: "success",
    message: "Backend is working correctly",
  });
});

// Get all rooms from Supabase PostgreSQL
app.get("/api/rooms", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("rooms")
      .select("*")
      .order("id", { ascending: true });

    if (error) {
      console.error("Supabase query failed:", error.message);

      return res.status(500).json({
        success: false,
        error: "Unable to retrieve rooms",
      });
    }

    return res.status(200).json({
      success: true,
      count: data.length,
      rooms: data,
    });
  } catch (error) {
    console.error("Unexpected error:", error);

    return res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(
    `Express server running on http://localhost:${PORT}`
  );
});
