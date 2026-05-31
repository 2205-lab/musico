import sys
import json

def analyze_audio(file_path):
    try:
        import librosa
        import numpy as np

        print("Loading audio...", file=sys.stderr)

        # Load FULL file for accurate duration, but analyze only 60s
        y_full, sr = librosa.load(file_path, mono=True, sr=22050)
        real_duration = int(librosa.get_duration(y=y_full, sr=sr))
        
        # Use first 60s for analysis (faster)
        y = y_full[:sr*60] if len(y_full) > sr*60 else y_full

        if len(y) < 1000:
            print(json.dumps({'error': 'Audio too short'}))
            return

        print(f"Duration: {real_duration}s", file=sys.stderr)

        # ─── BPM ──────────────────────────────────────────
        y_harmonic, y_percussive = librosa.effects.hpss(y)
        
        onset_env = librosa.onset.onset_strength(
            y=y_percussive,
            sr=sr,
            aggregate=np.median
        )

        # Get tempo candidates
        tempo_candidates = librosa.beat.tempo(
            onset_envelope=onset_env,
            sr=sr,
            ac_size=8.0,
            aggregate=None
        )
        
        bpm_raw = float(np.atleast_1d(tempo_candidates)[0])
        
        # Always prefer tempo in 70-160 BPM range
        # If detected BPM is too high, halve it
        # If too low, double it
        bpm = bpm_raw
        while bpm > 160:
            bpm /= 2
        while bpm < 70:
            bpm *= 2
            
        bpm = int(round(bpm))

        print(f"BPM raw: {bpm_raw}, final: {bpm}", file=sys.stderr)

        # ─── KEY ──────────────────────────────────────────
        chroma = librosa.feature.chroma_cqt(
            y=y_harmonic,
            sr=sr,
            bins_per_octave=36,
            hop_length=512
        )

        # Use median instead of mean — more robust to outliers
        chroma_vals = np.median(chroma, axis=1)
        chroma_vals = chroma_vals / (np.max(chroma_vals) + 1e-10)

        key_names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']

        # Krumhansl-Schmuckler profiles
        major_profile = np.array([6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88])
        minor_profile = np.array([6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17])
        major_profile /= major_profile.sum()
        minor_profile /= minor_profile.sum()

        best_score = -999
        best_key = 'C'
        best_mode = 'Major'

        for i in range(12):
            rotated = np.roll(chroma_vals, -i)
            maj = float(np.corrcoef(rotated, major_profile)[0,1])
            min_ = float(np.corrcoef(rotated, minor_profile)[0,1])
            if maj > best_score:
                best_score = maj
                best_key = key_names[i]
                best_mode = 'Major'
            if min_ > best_score:
                best_score = min_
                best_key = key_names[i]
                best_mode = 'Minor'

        print(f"Key: {best_key} {best_mode}", file=sys.stderr)

        # ─── ENERGY ───────────────────────────────────────
        rms = librosa.feature.rms(y=y)
        energy_percent = min(100, max(1, int(float(np.mean(rms)) * 3000)))

        # ─── BRIGHTNESS ───────────────────────────────────
        centroid_mean = float(np.mean(librosa.feature.spectral_centroid(y=y, sr=sr)))
        if centroid_mean < 1500:
            brightness = 'Dark (heavy low end)'
        elif centroid_mean < 3000:
            brightness = 'Balanced'
        else:
            brightness = 'Bright (strong high end)'

        # ─── BASS RATIO ───────────────────────────────────
        fft = np.abs(np.fft.rfft(y))
        freqs = np.fft.rfftfreq(len(y), 1/sr)
        bass_ratio = min(100, max(0, int(
            float(np.mean(fft[freqs < 250])) /
            (float(np.mean(fft)) + 1e-10) * 100
        )))

        result = {
            'bpm': bpm,
            'key': f'{best_key} {best_mode}',
            'energy': energy_percent,
            'brightness': brightness,
            'bass_ratio': bass_ratio,
            'danceability': min(100, max(0, int((bpm - 60) / 1.2))),
            'duration': real_duration
        }

        print("Success!", file=sys.stderr)
        print(json.dumps(result))

    except Exception as e:
        import traceback
        print(traceback.format_exc(), file=sys.stderr)
        print(json.dumps({'error': str(e)}))

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'No file path provided'}))
    else:
        analyze_audio(sys.argv[1])
