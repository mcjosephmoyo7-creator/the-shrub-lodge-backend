
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { supabase } from "./supabase.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
  })
);

app.use(express.json());

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
