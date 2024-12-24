import { json } from '@sveltejs/kit';
import fs from 'fs/promises';
import path from 'path';

const CONFIG_PATH = path.join(process.cwd(), 'src/lib/config/devices.json');

export async function GET() {
  try {
    const data = await fs.readFile(CONFIG_PATH, 'utf-8');
    return json(JSON.parse(data));
  } catch (error) {
    return json({ devices: [] });
  }
}

export async function POST({ request }) {
  try {
    const { devices } = await request.json();
    await fs.writeFile(CONFIG_PATH, JSON.stringify({ devices }, null, 2));
    return json({ success: true });
  } catch (error) {
    return json({ success: false, error: error.message });
  }
} 