#pragma once

#include <Arduino.h>

// Fixed-capacity ring buffer used to keep sampling sensor data while no BLE
// central is connected. Once full, the oldest unread sample is overwritten so
// the buffer always holds the most recent window of offline data.
template <typename T, uint16_t Capacity>
class HistoryBuffer {
public:
  HistoryBuffer() : _head(0), _count(0), _overflowed(false) {}

  void push(const T& sample) {
    _data[_head] = sample;
    _head = (_head + 1) % Capacity;
    if (_count < Capacity) {
      ++_count;
    } else {
      _overflowed = true;
    }
  }

  bool pop(T& out) {
    if (_count == 0) {
      return false;
    }
    const uint16_t tail = (_head + Capacity - _count) % Capacity;
    out = _data[tail];
    --_count;
    return true;
  }

  uint16_t size() const { return _count; }
  bool empty() const { return _count == 0; }
  bool overflowed() const { return _overflowed; }
  void clearOverflowFlag() { _overflowed = false; }

private:
  T _data[Capacity];
  uint16_t _head;
  uint16_t _count;
  bool _overflowed;
};
