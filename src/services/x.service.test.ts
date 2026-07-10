import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { describe, it, expect } from 'vitest';
import { XService } from './x.service.js';
import axios from 'axios';

dotenv.config();

describe('XService (X SDK API Integration)', () => {
  it('should post a test image and text to X', async () => {
    const xService = new XService();
    const generatedDir = path.join(__dirname, '..', '..', 'generated');
    let testImagePath = path.join(generatedDir, 'testimage.png');

    if (!fs.existsSync(testImagePath)) {
      const files = fs.existsSync(generatedDir) ? fs.readdirSync(generatedDir) : [];
      const pngFile = files.find(f => f.endsWith('.png'));
      if (pngFile) {
        fs.copyFileSync(path.join(generatedDir, pngFile), testImagePath);
      } else {
        const dummyBuffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
        if (!fs.existsSync(generatedDir)) fs.mkdirSync(generatedDir, { recursive: true });
        fs.writeFileSync(testImagePath, dummyBuffer);
      }
    }

    const imageBuffer = fs.readFileSync(testImagePath);

    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const year = now.getFullYear();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const dateStr = `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;

    const postMessage = `POST TEXT (áéíóú) (${dateStr}) 💧⚡🌊🤖`;

    console.log(`[Test] Attempting to post to X: "${postMessage}" with image size ${imageBuffer.length} bytes`);

    const result = await xService.postTweet(postMessage, imageBuffer);
    expect(result).toBeDefined();
  }, 40000);

  it('should successfully verify the bearer token against a read-only endpoint', async () => {
    const token = process.env.BEARER_TOKEN || process.env.X_BEARER_TOKEN;
    
    if (!token) {
      console.warn('[X Connection Test] Skipping test: No BEARER_TOKEN or X_BEARER_TOKEN found in environment variables.');
      return;
    }

    console.log('[X Connection Test] Querying xdevelopers profile to verify Bearer Token connection...');
    
    const response = await axios.get('https://api.x.com/2/users/by/username/xdevelopers', {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    expect(response.status).toBe(200);
    expect(response.data).toBeDefined();
    expect(response.data.data).toBeDefined();
    expect(response.data.data.username.toLowerCase()).toBe('xdevelopers');
    
    console.log('[X Connection Test] Bearer token verified successfully! Account ID:', response.data.data.id);
  });
});
