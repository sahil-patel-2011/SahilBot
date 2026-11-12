---
name: signal-processing
description: Filter, analyze or transform signals (FFT, filtering, sampling) with Python.
source: you
uses: 0
category: Electrical Engineering
---

1. Load the data (CSV, WAV); note sample rate, units and length.
2. Check sampling: fs > 2*fmax, anti-aliasing, a window for FFTs (Hann), resolution = fs/N.
3. Use numpy/scipy: scipy.signal for filter design (butter, firwin), filtfilt for zero-phase filtering, welch for spectra.
4. Plot to a PNG (matplotlib, labeled axes with units) and give the path.
5. Explain what it means in plain words (main frequencies, noise floor, cutoff).
