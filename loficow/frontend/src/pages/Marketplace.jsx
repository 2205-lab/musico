import { useState, useEffect, useCallback } from 'react'
import { Search, SlidersHorizontal, Plus, Music2 } from 'lucide-react'
import { api } from '../utils/api'
import { useAuth } from '../context/AuthContext'
import BeatCard from '../components/marketplace/BeatCard'
import toast from 'react-hot-toast'

const MOODS   = ['Chill','Melancholic','Dreamy','Dark','Upbeat','Nostalgic','Study','Rain']
const SORT_BY = ['newest','popular','likes']

export default function Marketplace() {
  const [beats,  setBeats]  = useState([])
  const [search, setSearch] = useState('')
  const [mood,   setMood]   = useState(null)
  const [sort,   setSort]   = useState('newest')
  const [free,   setFree]   = useState(false)
  const [page,   setPage]   = useState(1)
  const [hasMore,setHasMore]= useState(true)
  const [loading,setLoading]= useState(false)
  const { user } = useAuth()

  const load = useCallback(async (reset = false) => {
    setLoading(true)
    try {
      const p = reset ? 1 : page
      const q = { page: p, sort, limit: 12 }
      if (mood) q.mood = mood
      if (free) q.free = 1
      const data = await api.get('/beats', q)
      if (reset) setBeats(data.beats)
      else       setBeats(prev => [...prev, ...data.beats])
      setHasMore(p < data.meta.pages)
      setPage(p + 1)
    } catch (e) { console.error(e) }
    finally { setLoading(false) }
  }, [mood, sort, free, page])

  useEffect(() => { setPage(1); setBeats([]); load(true) }, [mood, sort, free])

  return (
    <div className="max-w-6xl mx-auto py-8 px-4 pb-32">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="font-display font-bold text-3xl text-slate-100">Beat Market</h1>
          <p className="text-slate-500 mt-1">Discover and license lofi beats</p>
        </div>
        {user && (
          <button
            onClick={() => toast('Upload beat feature coming soon!')}
            className="btn-primary flex items-center gap-2"
          >
            <Plus className="w-4 h-4" /> Upload Beat
          </button>
        )}
      </div>

      {/* Filters */}
      <div className="glass rounded-2xl p-4 mb-8 space-y-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search beats, artists, moods..."
            className="input pl-10 text-sm"
          />
        </div>

        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-slate-500">Mood:</span>
            {MOODS.map(m => (
              <button
                key={m}
                onClick={() => setMood(mood === m ? null : m)}
                className={`text-xs px-3 py-1.5 rounded-full border transition-all ${
                  mood === m
                    ? 'border-purple-500 bg-purple-500/15 text-purple-300'
                    : 'border-white/10 text-slate-400 hover:border-white/20'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3 ml-auto">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={free} onChange={e => setFree(e.target.checked)}
                className="accent-purple-500" />
              <span className="text-xs text-slate-400">Free only</span>
            </label>
            <select
              value={sort} onChange={e => setSort(e.target.value)}
              className="bg-surface border border-white/8 text-xs text-slate-300 rounded-lg px-3 py-2 outline-none"
            >
              {SORT_BY.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>
      </div>

      {/* Grid */}
      {beats.length === 0 && !loading ? (
        <div className="text-center py-24">
          <Music2 className="w-12 h-12 text-slate-700 mx-auto mb-4" />
          <p className="text-slate-500">No beats found. Be the first to upload!</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-5">
          {beats.map(beat => <BeatCard key={beat.id} beat={beat} />)}
        </div>
      )}

      {loading && (
        <div className="flex justify-center py-12">
          <div className="w-8 h-8 rounded-full border-2 border-purple-500/30 border-t-purple-500 animate-spin" />
        </div>
      )}

      {hasMore && !loading && beats.length > 0 && (
        <div className="text-center mt-8">
          <button onClick={() => load(false)} className="btn-secondary">Load more beats</button>
        </div>
      )}
    </div>
  )
}
