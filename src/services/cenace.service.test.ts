import { describe, it, expect } from 'vitest';
import { CenaceService } from './cenace.service.js';

describe('CenaceService - decodePlotlyArray', () => {
  const service = new (CenaceService as any)(); // Cast as any to access private/protected helper methods

  it('should return the same array if a normal array of numbers is provided', () => {
    const input = [10.5, 20, 30.2, null];
    const result = service.decodePlotlyArray(input);
    expect(result).toEqual([10.5, 20, 30.2, null]);
  });

  it('should decode a base64 float64 array correctly (single value: 1.0)', () => {
    const mockPayload = {
      dtype: 'f8',
      bdata: 'AAAAAAAA8D8=' // Little-endian float64 representation of 1.0
    };
    const result = service.decodePlotlyArray(mockPayload);
    expect(result).toEqual([1.0]);
  });

  it('should decode a base64 float64 array with multiple values (1.0, 2.0, 3.0)', () => {
    const mockPayload = {
      dtype: 'f8',
      bdata: 'AAAAAAAA8D8AAAAAAAAAQAAAAAAAAAhA' // 1.0, 2.0, 3.0 (Float64 LE)
    };
    const result = service.decodePlotlyArray(mockPayload);
    expect(result).toEqual([1.0, 2.0, 3.0]);
  });

  it('should convert IEEE 754 NaN values in base64 streams to null', () => {
    const mockPayload = {
      dtype: 'f8',
      bdata: 'AAAAAAAA+H8=' // Little-endian float64 representation of NaN
    };
    const result = service.decodePlotlyArray(mockPayload);
    expect(result).toEqual([null]);
  });

  it('should return an empty array if invalid structure is provided', () => {
    expect(service.decodePlotlyArray(null)).toEqual([]);
    expect(service.decodePlotlyArray('not-an-object')).toEqual([]);
    expect(service.decodePlotlyArray({ dtype: 'f4' })).toEqual([]); // Unsupported float32
  });
});
