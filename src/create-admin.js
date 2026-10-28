import "./env.js";
import { hashPassword } from "./passwords.js";
import { supabase } from "./supabase.js";

const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD;

if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  throw new Error("Set ADMIN_EMAIL to a valid email address before creating an admin.");
}

if (!password) {
  throw new Error("Set a non-empty ADMIN_PASSWORD before creating an admin.");
}

const passwordHash = await hashPassword(password);
const { data, error } = await supabase
  .from("admin_users")
  .insert({
    email,
    password_hash: passwordHash,
    role: "admin",
  })
  .select("id, email")
  .single();

if (error) {
  if (error.code === "23505") {
    throw new Error("An admin account with that email already exists.");
  }
  throw new Error(`Unable to create admin account: ${error.message}`);
}

console.log(`Created admin account for ${data.email}.`);
