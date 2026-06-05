import { Play, Pause, Volume2 } from 'lucide-react'
import { usePlayer } from '../../context/PlayerContext'
import WaveformBars from './WaveformBars'

function fmt(sec) {
  if (!sec || isNaN(sec)) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60).toString().padStart(2, '0')
  return `${m}:${s}`
}

export default function AudioPlayer({ track, compact = false }) {
  const { track: current, playing, progress, duration, play, pause, resume, seek } = usePlayer()
  const isThis    = current?.audio_url === track.audio_url
  const isPlaying = isThis && playing

  function handlePlay(e) {
    e.stopPropagation()
    if (isThis) { isPlaying ? pause() : resume() }
    else        { play(track) }
  }

  function handleSeek(e) {
    if (!isThis || !duration) return
    const rect = e.currentTarget.getBoundingClientRect()
    const pct  = (e.clientX - rect.left) / rect.width
    seek(pct * duration)
  }

  const pct = isThis && duration ? (progress / duration) * 100 : 0

  if (compact) {
    return (
      <button
        onClick={handlePlay}
        className="w-9 h-9 rounded-full bg-purple-600 hover:bg-purple-500 flex items-center justify-center
          transition-all duration-200 hover:shadow-glow-purple flex-shrink-0"
      >
        {isPlaying
          ? <Pause className="w-4 h-4 text-white" />
          : <Play  className="w-4 h-4 text-white ml-0.5" />}
      </button>
    )
  }

  return (
    <div className="flex items-center gap-3 w-full">
      <button
        onClick={handlePlay}
        className="w-10 h-10 rounded-full bg-purple-600 hover:bg-purple-500 flex items-center justify-center
          transition-all duration-200 hover:shadow-glow-purple flex-shrink-0"
      >
        {isPlaying
          ? <Pause className="w-4 h-4 text-white" />
          : <Play  className="w-4 h-4 text-white ml-0.5" />}
      </button>

      <div className="flex-1 min-w-0">
        {isPlaying && <WaveformBars playing bars={8} color="bg-purple-400" />}
        <div
          className="mt-1 h-1.5 bg-surface-active rounded-full cursor-pointer group relative"
          onClick={handleSeek}
        >
          <div
            className="h-full bg-gradient-to-r from-purple-500 to-cyan-400 rounded-full
              transition-all duration-100 relative"
            style={{ width: `${pct}%` }}
          >
            <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 rounded-full
              bg-white shadow-md opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        </div>
      </div>

      <span className="text-xs text-slate-500 flex-shrink-0 tabular-nums">
        {isThis ? fmt(progress) : '0:00'} / {fmt(isThis ? duration : track.track_duration)}
      </span>
    </div>
  )
}
