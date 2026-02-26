import { renderHook, act } from '@testing-library/react';
import { useStore } from '../useStore';
import { vi } from 'vitest';

describe('useStore', () => {
  beforeEach(() => {
    useStore.setState({
      liveState: null,
      lastSequence: 0,
    });
  });

  describe('updateLiveState', () => {
    it('should not update with stale sequence number', () => {
      const { result } = renderHook(() => useStore());
      
      act(() => {
        result.current.updateLiveState({ frequency: 145.5, modulation: 'FM' }, 5);
      });
      
      act(() => {
        result.current.updateLiveState({ frequency: 146.0, modulation: 'FM' }, 3);
      });

      expect(result.current.liveState?.frequency).toBe(145.5);
    });

    it('should bootstrap initial state from partial updates', () => {
      const { result } = renderHook(() => useStore());
      
      act(() => {
        result.current.updateLiveState({ mode: 'SCAN' }, 1);
      });

      expect(result.current.liveState).toEqual(
        expect.objectContaining({
          mode: 'SCAN',
          frequency: 0,
          modulation: 'FM',
        })
      );
    });

    it('should merge partial updates when liveState exists', () => {
      const { result } = renderHook(() => useStore());
      
      act(() => {
        result.current.updateLiveState({ 
          frequency: 145.5, 
          modulation: 'FM',
          mode: 'SCAN'
        }, 1);
      });

      act(() => {
        result.current.updateLiveState({ rssi: 80 }, 2);
      });

      expect(result.current.liveState).toEqual(
        expect.objectContaining({
          frequency: 145.5,
          modulation: 'FM',
          mode: 'SCAN',
          rssi: 80,
        })
      );
    });
  });

  describe('addActivityLogEntry', () => {
    it('should limit log to 5 entries', () => {
      const { result } = renderHook(() => useStore());
      
      for (let i = 1; i <= 7; i++) {
        act(() => {
          result.current.addActivityLogEntry({
            id: `entry-${i}`,
            timestamp: Date.now() / 1000,
            frequency: 145.5,
            type: 'hit',
          });
        });
      }

      expect(result.current.activityLog).toHaveLength(5);
      expect(result.current.activityLog[0].id).toBe('entry-7');
    });
  });

  describe('addToFullActivityLog', () => {
    it('should keep all entries', () => {
      const { result } = renderHook(() => useStore());
      
      for (let i = 1; i <= 7; i++) {
        act(() => {
          result.current.addToFullActivityLog({
            id: `entry-${i}`,
            timestamp: Date.now() / 1000,
            frequency: 145.5,
            type: 'hit',
          });
        });
      }

      expect(result.current.fullActivityLog).toHaveLength(7);
    });
  });

  describe('setChannels', () => {
    it('should handle undefined channels', () => {
      const { result } = renderHook(() => useStore());
      
      act(() => {
        result.current.setChannels(undefined as any);
      });

      expect(result.current.channels).toEqual([]);
    });

    it('should handle null channels', () => {
      const { result } = renderHook(() => useStore());
      
      act(() => {
        result.current.setChannels(null as any);
      });

      expect(result.current.channels).toEqual([]);
    });
  });
});
