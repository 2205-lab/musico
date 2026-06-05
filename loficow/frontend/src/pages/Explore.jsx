import { useState, useEffect } from 'react'
import { Search, BadgeCheck, Music2, Users } from 'lucide-react'
import { Link } from 'react-router-dom'
import { api } from '../utils/api'
import Avatar from '../components/ui/Avatar'

export default function Explore() {
  const [query,   setQuery]   = useState('')
  const [results, setResults] = useState({ artists: [], beats: [], posts: [] })
  const [loading, setLoading] = useState(false)
  const [tab,     setTab]     = useState('artists')

  useEffect(() => {
    const timeout = setTimeout(() => {
      if (query.length < 2) { setResults({ artists: [], beats: [], posts: [] }); return }
      setLoading(true)
      api.get('/explore', { q: query })
        .then(d => setResults(d))
        .catch(console.error)
        .finally(() => setLoading(false))
    }, 400)
    return () => clearTimeout(timeout)
  }, [query])

  useEffect(() => {
    if (!query) {
      setLoading(true)
      api.get('/explore', { q: '' })
        .then(d => setResults(d))
        .catch(console.error)
        .finally(() => setLoading(false))
    }
  }, [])

  const tabs = [
    { key: 'artists', label: 'Artists', count: results.artists.length },
    { key: 'beats',   label: 'Beats',   count: results.beats.length },
  ]

  return (
    <div className="max-w-3xl mx-auto py-8 px-4 pb-24">
      <h1 className="font-display font-bold text-3xl text-slate-100 mb-6">Explore</h1>

      <div className="relative mb-6">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-500" />
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search artists, beats, tags..."
          className="input pl-12 text-base py-4"
          autoFocus
        />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-white/5">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t.key
                ? 'border-purple-500 text-purple-300'
                : 'border-transparent text-slate-500 hover:text-slate-300'
            }`}
          >
            {t.label}
            {t.count > 0 && <span className="ml-2 badge-purple text-xs">{t.count}</span>}
          </button>
        ))}
      </div>

      {loading && (
        <div className="flex justify-center py-12">
          <div className="w-7 h-7 rounded-full border-2 border-purple-500/30 border-t-purple-500 animate-spin" />
        </div>
      )}

      {/* Artists */}
      {tab === 'artists' && !loading && (
        <div className="space-y-3">
          {results.artists.length === 0
            ? <div className="text-center py-16 text-slate-500">
                {query ? 'No artists found' : 'Search for artists'}
              </div>
            : results.artists.map(a => (
                <Link key={a.id} to={`/profile/${a.username}`}
                  className="card card-hover p-4 flex items-center gap-4 block hover:no-underline">
                  <Avatar user={a} size="md" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-slate-100">{a.display_name}</span>
                      {a.verified && <BadgeCheck className="w-4 h-4 text-cyan-400" />}
                      <span className={`ml-1 ${a.account_type === 'label' ? 'badge-cyan' : 'badge-purple'}`}>
                        {a.account_type}
                      </span>
                    </div>
                    <p className="text-sm text-slate-500">@{a.username}</p>
                    {a.bio && <p className="text-xs text-slate-400 mt-1 truncate">{a.bio}</p>}
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="font-bold text-slate-100 text-sm">{a.followers_count}</p>
                    <p className="text-xs text-slate-500">followers</p>
                  </div>
                </Link>
              ))
          }
        </div>
      )}

      {/* Beats */}
      {tab === 'beats' && !loading && (
        <div className="space-y-3">
          {results.beats.length === 0
            ? <div className="text-center py-16 text-slate-500">
                {query ? 'No beats found' : 'Search for beats'}
              </div>
            : results.beats.map(b => (
                <div key={b.id} className="card card-hover p-4 flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl overflow-hidden bg-surface flex-shrink-0">
                    {b.cover_url
                      ? <img src={b.cover_url} alt="" className="w-full h-full object-cover" />
                      : <div className="w-full h-full flex items-center justify-center">
                          <Music2 className="w-5 h-5 text-purple-400" />
                        </div>
                    }
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-slate-100 truncate">{b.title}</p>
                    <p className="text-xs text-slate-500">{b.display_name}</p>
                    <div className="flex gap-1.5 mt-1">
                      {b.bpm  && <span className="badge-purple">{b.bpm} BPM</span>}
                      {b.mood && <span className="badge-cyan">{b.mood}</span>}
                    </div>
                  </div>
                  <div className="text-xs text-slate-500 flex-shrink-0">
                    {b.plays_count} plays
                  </div>
                </div>
              ))
          }
        </div>
      )}
    </div>
  )
}
