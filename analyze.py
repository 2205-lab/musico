import sys
import json

def analyze_audio(file_path):
    try:
        import librosa
        import numpy as np

        print("Loading audio...", file=sys.stderr)

        # Load 60 seconds for better accuracy
        y, sr = librosa.load(file_path, duration=60, mono=True, sr=44100)

        if len(y) < 1000:
            print(json.dumps({'error': 'Audio too short'}))
            return

        # ─── BPM (more accurate method) ───────────────────
        # Use harmonic-percussive separation first
        y_harmonic, y_percussive = librosa.effects.hpss(y)
        
        # Use percussive signal for better beat tracking
        onset_env = librosa.onset.onset_strength(
            y=y_percussive, 
            sr=sr,
            aggregate=np.median
        )
        
        # Get multiple tempo candidates and pick best
        tempo = librosa.beat.tempo(
            onset_envelope=onset_env, 
            sr=sr,
            ac_size=8.0
        )
        bpm = int(round(float(np.atleast_1d(tempo)[0])))
        
        # Keep BPM in realistic range 60-200
        while bpm < 60:
            bpm *= 2
        while bpm > 200:
            bpm //= 2

        # ─── KEY (more accurate method) ───────────────────
        # Use harmonic signal only for key detection
        chroma = librosa.feature.chroma_cqt(
            y=y_harmonic,
            sr=sr,
            bins_per_octave=36
        )
        
        # Smooth chroma over time for stability
        chroma_smooth = np.mean(chroma, axis=1)
        
        # Normalize
        chroma_smooth = chroma_smooth / (np.max(chroma_smooth) + 1e-10)

        key_names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']
        
        # Krumhansl-Schmuckler key profiles (more accurate)
        major_profile = np.array([6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88])
        minor_profile = np.array([6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17])
        
        major_profile = major_profile / major_profile.sum()
        minor_profile = minor_profile / minor_profile.sum()

        best_score = -1
        best_key = 'C'
        best_mode = 'Major'

        for i in range(12):
            rotated_chroma = np.roll(chroma_smooth, -i)
            
            major_score = float(np.corrcoef(rotated_chroma, major_profile)[0,1])
            minor_score = float(np.corrcoef(rotated_chroma, minor_profile)[0,1])
            
            if major_score > best_score:
                best_score = major_score
                best_key = key_names[i]
                best_mode = 'Major'
            
            if minor_score > best_score:
                best_score = minor_score
                best_key = key_names[i]
                best_mode = 'Minor'

        # ─── ENERGY ───────────────────────────────────────
        rms = librosa.feature.rms(y=y)
        energy_val = float(np.mean(rms))
        energy_percent = min(100, max(1, int(energy_val * 3000)))

        # ─── BRIGHTNESS ───────────────────────────────────
        centroid = librosa.feature.spectral_centroid(y=y, sr=sr)
        centroid_mean = float(np.mean(centroid))
        if centroid_mean < 1500:
            brightness = 'Dark (heavy low end)'
        elif centroid_mean < 3000:
            brightness = 'Balanced'
        else:
            brightness = 'Bright (strong high end)'

        # ─── BASS RATIO ───────────────────────────────────
        fft = np.abs(np.fft.rfft(y))
        freqs = np.fft.rfftfreq(len(y), 1/sr)
        bass_energy = float(np.mean(fft[freqs < 250]))
        total_energy = float(np.mean(fft)) + 1e-10
        bass_ratio = min(100, max(0, int((bass_energy / total_energy) * 100)))

        # ─── DURATION ─────────────────────────────────────
        duration = int(librosa.get_duration(y=y, sr=sr))

        result = {
            'bpm': bpm,
            'key': f'{best_key} {best_mode}',
            'energy': energy_percent,
            'brightness': brightness,
            'bass_ratio': bass_ratio,
            'danceability': min(100, max(0, int((bpm - 60) / 1.2))),
            'duration': duration
        }

        print("Success!", file=sys.stderr)
        print(json.dumps(result))

    except Exception as e:
        import traceback
        print(f"Error: {e}", file=sys.stderr)
        print(traceback.format_exc(), file=sys.stderr)
        print(json.dumps({'error': str(e)}))

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'No file path provided'}))
    else:
        analyze_audio(sys.argv[1])
