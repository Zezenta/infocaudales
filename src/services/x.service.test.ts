import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { describe, it, expect } from 'vitest';
import { XService } from './x.service.js';
import axios from 'axios';

dotenv.config();

describe('XService (X SDK API Integration)', () => {
  it('should post a test image and text to X', async () => {
    if (process.env.TEST_LIVE_X !== 'true') {
      console.log('[X Test] Skipping live tweet posting test (set TEST_LIVE_X=true to enable).');
      return;
    }
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

  describe('Video Upload & Posting (Mock Unit Tests)', () => {
    it('should perform chunked video upload (INIT -> APPEND -> FINALIZE -> STATUS)', async () => {
      const appendedChunks: any[] = [];
      let statusCallCount = 0;

      const mockClient = {
        media: {
          initializeUpload: async (opts: any) => {
            expect(opts.body.mediaCategory).toBe('tweet_video');
            expect(opts.body.mediaType).toBe('video/mp4');
            return { data: { id: 'mock_vid_999' } };
          },
          appendUpload: async (id: string, opts: any) => {
            expect(id).toBe('mock_vid_999');
            appendedChunks.push(opts.body);
            return { data: {} };
          },
          finalizeUpload: async (id: string) => {
            expect(id).toBe('mock_vid_999');
            return {
              data: {
                id,
                processing_info: {
                  state: 'pending',
                  check_after_secs: 1
                }
              }
            };
          },
          getUploadStatus: async (id: string) => {
            statusCallCount++;
            return {
              data: {
                id,
                processing_info: {
                  state: 'succeeded',
                  progress_percent: 100
                }
              }
            };
          }
        },
        posts: {
          create: async (payload: any) => {
            return { data: { id: 'tweet_vid_123', ...payload } };
          }
        }
      } as any;

      const xService = new XService(mockClient);
      const fakeVideoBuffer = Buffer.alloc(3 * 1024 * 1024); // 3MB fake video

      const mediaId = await xService.uploadVideo(fakeVideoBuffer, { chunkSize: 1024 * 1024 });

      expect(mediaId).toBe('mock_vid_999');
      expect(appendedChunks.length).toBe(3); // 3 chunks
      expect(appendedChunks[0].segmentIndex).toBe(0);
      expect(appendedChunks[1].segmentIndex).toBe(1);
      expect(appendedChunks[2].segmentIndex).toBe(2);
      expect(statusCallCount).toBe(1);
    });

    it('should post a video tweet with postVideo', async () => {
      let createdPostPayload: any = null;

      const mockClient = {
        media: {
          initializeUpload: async () => ({ data: { id: 'vid_777' } }),
          appendUpload: async () => ({ data: {} }),
          finalizeUpload: async () => ({ data: { processing_info: { state: 'succeeded' } } }),
          getUploadStatus: async () => ({ data: { processing_info: { state: 'succeeded' } } })
        },
        posts: {
          create: async (payload: any) => {
            createdPostPayload = payload;
            return { data: { id: 'tweet_777' } };
          }
        }
      } as any;

      const xService = new XService(mockClient);
      const fakeVideo = Buffer.from('dummy video buffer');

      const result = await xService.postVideo('Alerta de Tormenta en Paute', fakeVideo);

      expect(result).toBeDefined();
      expect(createdPostPayload).toBeDefined();
      expect(createdPostPayload.text).toBe('Alerta de Tormenta en Paute');
      expect(createdPostPayload.media.media_ids).toEqual(['vid_777']);
    });

    it('should auto-detect MP4 video in postTweet and route to video upload', async () => {
      let uploadedCategory = '';

      const mockClient = {
        media: {
          initializeUpload: async (opts: any) => {
            uploadedCategory = opts.body.mediaCategory;
            return { data: { id: 'vid_mp4_detected' } };
          },
          appendUpload: async () => ({ data: {} }),
          finalizeUpload: async () => ({ data: { processing_info: { state: 'succeeded' } } }),
          getUploadStatus: async () => ({ data: { processing_info: { state: 'succeeded' } } })
        },
        posts: {
          create: async (payload: any) => ({ data: { id: 'tweet_detected' } })
        }
      } as any;

      const xService = new XService(mockClient);
      // Construct buffer with 'ftyp' box at offset 4
      const mp4HeaderBuffer = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);

      await xService.postTweet('Auto-detected MP4 video tweet', mp4HeaderBuffer);

      expect(uploadedCategory).toBe('tweet_video');
    });
  });
});
