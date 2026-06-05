import { Play, Pause, Volume2, VolumeX, X, Music2 } from 'lucide-react'
import { usePlayer } from '../../context/PlayerContext'
import { useNavigate } from 'react-router-dom'
import Avatar from '../ui/Avatar'
import WaveformBars from '../ui/WaveformBars'

function fmt(sec) {
  if (!sec || isNaN(sec)) return '0:00'
  return `${Math.floor(sec / 60)}:${Math.floor(sec % 60).toString().padStart(2,'0')}`
}

export default function MusicPlayer() {
  const { track, playing, progress, duration, pause, resume, seek, volume, changeVolume } = usePlayer()
  if (!track) return null

  const pct = duration ? (progress / duration) * 100 : 0

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 glass-strong border-t border-white/5">
      <div className="max-w-screen-xl mx-auto px-6 py-3 flex items-center gap-6">
        {/* Track info */}
        <div className="flex items-center gap-3 w-72 flex-shrink-0">
          <div className="w-11 h-11 rounded-lg overflow-hidden bg-surface flex-shrink-0">
            {track.cover_url
              ? <img src={track.cover_url} alt="" className="w-full h-full object-cover" />
              : <div className="w-full h-full flex items-center justify-center">
                  <Music2 className="w-5 h-5 text-purple-400" />
                </div>
            }
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-slate-100 truncate">{track.track_title || track.title || 'Untitled'}</p>
            <p className="text-xs text-slate-500 truncate">{track.display_name || track.username}</p>
          </div>
          {playing && <WaveformBars playing bars={4} color="bg-purple-400" />}
        </div>

        {/* Controls */}
        <div className="flex-1 flex flex-col items-center gap-1.5">
          <div className="flex items-center gap-4">
            <button
              onClick={playing ? pause : resume}
              className="w-10 h-10 rounded-full bg-purple-600 hover:bg-purple-500 flex items-center justify-center
                transition-all hover:shadow-glow-purple"
            >
              {playing
                ? <Pause className="w-4 h-4 text-white" />
                : <Play  className="w-4 h-4 text-white ml-0.5" />}
            </button>
          </div>
          <div className="w-full flex items-center gap-2">
            <span className="text-xs text-slate-500 w-10 text-right tabular-nums">{fmt(progress)}</span>
            <div
              className="flex-1 h-1 bg-surface-active rounded-full cursor-pointer group"
              onClick={e => {
                const rect = e.currentTarget.getBoundingClientRect()
                seek(((e.clientX - rect.left) / rect.width) * duration)
              }}
            >
              <div className="h-full bg-gradient-to-r from-purple-500 to-cyan-400 rounded-full"
                style={{ width: `${pct}%` }} />
            </div>
            <span className="text-xs text-slate-500 w-10 tabular-nums">{fmt(duration)}</span>
          </div>
        </div>

        {/* Volume */}
        <div className="flex items-center gap-2 w-36 flex-shrink-0">
          <button onClick={() => changeVolume(volume > 0 ? 0 : 0.8)}>
            {volume === 0
              ? <VolumeX className="w-4 h-4 text-slate-400" />
              : <Volume2 className="w-4 h-4 text-slate-400" />}
          </button>
          <input
            type="range" min="0" max="1" step="0.05" value={volume}
            onChange={e => changeVolume(parseFloat(e.target.value))}
            className="flex-1 h-1 accent-purple-500 cursor-pointer"
          />
        </div>
      </div>
    </div>
  )
}
