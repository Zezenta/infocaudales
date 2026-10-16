import { describe, it, expect } from 'vitest';
import dotenv from 'dotenv';
import { MediaStorageService } from './media-storage.service.js';
import { FacebookService } from './facebook.service.js';
import { InstagramService } from './instagram.service.js';

dotenv.config();

describe('Social Media Services Unit Tests', () => {
  describe('MediaStorageService', () => {
    it('initializes with configuration parameters and detects configured state', () => {
      const storage = new MediaStorageService({
        endpoint: 'https://test-account.r2.cloudflarestorage.com',
        accessKeyId: 'test_access_key',
        secretAccessKey: 'test_secret_key',
        bucketName: 'test-bucket',
        publicBaseUrl: 'https://media.test.com',
      });
      expect(storage.isConfigured()).toBe(true);
    });

    it('detects unconfigured state when credentials are missing', () => {
      const storage = new MediaStorageService({
        endpoint: '',
        accessKeyId: '',
        secretAccessKey: '',
        publicBaseUrl: '',
      });
      expect(storage.isConfigured()).toBe(false);
    });

    it('returns existing URLs as-is without uploading again', async () => {
      const storage = new MediaStorageService();
      const existingUrl = 'https://pub-e89d342f94654583bedd87419524fc65.r2.dev/images/existing.png';
      const resultImg = await storage.uploadImage(existingUrl);
      const resultVid = await storage.uploadVideo(existingUrl);
      expect(resultImg).toBe(existingUrl);
      expect(resultVid).toBe(existingUrl);
    });

    it('throws error when uploading non-existent local file', async () => {
      const storage = new MediaStorageService();
      await expect(storage.uploadImage('/path/that/does/not/exist.png')).rejects.toThrow(
        'Local image file not found'
      );
    });
  });

  describe('FacebookService', () => {
    it('initializes with default environment variables', () => {
      const fb = new FacebookService();
      expect(fb).toBeDefined();
    });

    it('rejects postPhotos when empty array is passed', async () => {
      const fb = new FacebookService();
      await expect(fb.postPhotos([])).rejects.toThrow(
        'At least one photo is required'
      );
    });
  });

  describe('InstagramService', () => {
    it('initializes with default environment variables', () => {
      const ig = new InstagramService();
      expect(ig).toBeDefined();
    });

    it('rejects postCarousel with fewer than 2 items', async () => {
      const ig = new InstagramService();
      const singleItem = [Buffer.from('dummy')];
      await expect(ig.postCarousel(singleItem)).rejects.toThrow(
        'An Instagram Carousel requires at least 2 items'
      );
    });

    it('rejects postCarousel with more than 10 items', async () => {
      const ig = new InstagramService();
      const elevenItems = Array(11).fill(Buffer.from('dummy'));
      await expect(ig.postCarousel(elevenItems)).rejects.toThrow(
        'An Instagram Carousel allows a maximum of 10 items'
      );
    });
  });
});
