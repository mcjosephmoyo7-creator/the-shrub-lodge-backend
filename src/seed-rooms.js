/**
 * Seeds the Supabase `rooms` table with the lodge's room catalogue.
 *
 * The room data mirrors Frontend/src/lib/content/rooms.ts so the API and the
 * frontend stay in sync. Safe to re-run: rows are matched on `name`.
 *
 * Usage: npm run seed
 */

import dotenv from "dotenv";
import { supabase } from "./supabase.js";

dotenv.config();

const CDN = "https://static.wixstatic.com/media/";

const rooms = [
  {
    name: "Single Room",
    room_type: "Single",
    price_per_night: 150,
    capacity: 1,
    description:
      "Our Single Room offers a cosy and comfortable retreat, ideal for solo travellers. Equipped with a plush bed, an ensuite bathroom, air conditioning, and modern amenities, the room ensures a restful stay.",
    image_url: `${CDN}83df1a_7dc421ea56a24ea88ab35f6f9e4f5b18~mv2.jpeg`,
  },
  {
    name: "Double Room",
    room_type: "Double",
    price_per_night: 200,
    capacity: 2,
    description:
      "Experience the epitome of luxury at our lodge's double rooms. Immaculately clean and modernly styled, each room features a comfortable double bed for up to two guests. Book now for an unforgettable stay.",
    image_url: `${CDN}83df1a_ee3d64168c1f4087aadd5d92a807bf58~mv2.jpeg`,
  },
  {
    name: "Twin Room",
    room_type: "Twin",
    price_per_night: 200,
    capacity: 2,
    description:
      "The twin rooms offer two comfortable beds, accommodating a maximum of two individuals. Ideal for pairs seeking a harmonious stay, it boasts modern amenities and a meticulously maintained environment.",
    image_url: `${CDN}83df1a_ac28749fce0f4e98a6a2c7d770e01e07~mv2.jpeg`,
  },
];

async function seed() {
  for (const room of rooms) {
    const { data: existing, error: lookupError } = await supabase
      .from("rooms")
      .select("id")
      .eq("name", room.name)
      .maybeSingle();

    if (lookupError) {
      throw new Error(`Lookup failed for ${room.name}: ${lookupError.message}`);
    }

    if (existing) {
      const { error } = await supabase
        .from("rooms")
        .update(room)
        .eq("id", existing.id);
      if (error) throw new Error(`Update failed for ${room.name}: ${error.message}`);
      console.log(`Updated: ${room.name}`);
    } else {
      const { error } = await supabase.from("rooms").insert(room);
      if (error) throw new Error(`Insert failed for ${room.name}: ${error.message}`);
      console.log(`Inserted: ${room.name}`);
    }
  }

  console.log("Room seed complete.");
}

seed().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
