import dotenv from 'dotenv';
import { describe, it, expect } from 'vitest';
import axios from 'axios';

dotenv.config();

describe('X API Connection Verification', () => {
  it('should successfully verify the bearer token against a read-only endpoint', async () => {
    // Look for BEARER_TOKEN or falls back to X_BEARER_TOKEN / twitter-api-v2 values if any
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
