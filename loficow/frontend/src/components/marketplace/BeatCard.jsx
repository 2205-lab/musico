import { Heart, Music2, Play, Pause, BadgeCheck, Download } from 'lucide-react'
import { Link } from 'react-router-dom'
import Avatar from '../ui/Avatar'
import { usePlayer } from '../../context/PlayerContext'

export default function BeatCard({ beat }) {
  const { track, playing, play, pause } = usePlayer()
  const isThis    = track?.audio_url === beat.audio_url
  const isPlaying = isThis && playing

  function togglePlay(e) {
    e.preventDefault()
    if (isThis) { isPlaying ? pause() : undefined }
    else play({ ...beat, track_title: beat.title })
  }

  const lowestPrice = [beat.price_basic, beat.price_premium, beat.price_exclusive]
    .filter(Boolean).sort((a,b) => a - b)[0]

  return (
    <div className="card card-hover group overflow-hidden">
      {/* Cover art */}
      <div className="relative aspect-square overflow-hidden bg-surface">
        {beat.cover_url
          ? <img src={beat.cover_url} alt={beat.title} className="w-full h-full object-cover
              group-hover:scale-105 transition-transform duration-300" />
          : <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-purple-900/50 to-cyan-900/30">
              <Music2 className="w-12 h-12 text-purple-400/40" />
            </div>
        }
        {/* Play overlay */}
        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity
          flex items-center justify-center">
          <button
            onClick={togglePlay}
            className="w-14 h-14 rounded-full bg-purple-600 hover:bg-purple-500 flex items-center justify-center
              shadow-glow-purple scale-90 group-hover:scale-100 transition-all duration-200"
          >
            {isPlaying
              ? <Pause className="w-6 h-6 text-white" />
              : <Play  className="w-6 h-6 text-white ml-1" />}
          </button>
        </div>
        {/* Free badge */}
        {beat.is_free && (
          <div className="absolute top-2 left-2 badge-green text-xs">Free</div>
        )}
      </div>

      <div className="p-4">
        <h3 className="font-semibold text-slate-100 truncate">{beat.title}</h3>
        <Link to={`/profile/${beat.username}`} className="flex items-center gap-1.5 mt-1 group/user">
          <Avatar user={beat} size="xs" />
          <span className="text-xs text-slate-400 group-hover/user:text-purple-300 transition-colors truncate">
            {beat.display_name}
          </span>
          {beat.verified && <BadgeCheck className="w-3 h-3 text-cyan-400 flex-shrink-0" />}
        </Link>

        {/* Metadata */}
        <div className="flex items-center gap-2 mt-2">
          {beat.bpm && <span className="badge-purple">{beat.bpm} BPM</span>}
          {beat.key && <span className="badge-cyan">{beat.key}</span>}
          {beat.mood && <span className="text-xs text-slate-500">{beat.mood}</span>}
        </div>

        {/* Stats & price */}
        <div className="flex items-center justify-between mt-3 pt-3 border-t border-white/5">
          <div className="flex items-center gap-3 text-xs text-slate-500">
            <span className="flex items-center gap-1"><Play className="w-3 h-3" />{beat.plays_count}</span>
            <span className="flex items-center gap-1"><Heart className="w-3 h-3" />{beat.likes_count}</span>
          </div>
          {beat.is_free
            ? <button className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1">
                <Download className="w-3 h-3" /> Free
              </button>
            : lowestPrice
              ? <button className="btn-primary text-xs py-1.5 px-3">
                  From ${lowestPrice}
                </button>
              : null
          }
        </div>
      </div>
    </div>
  )
}
