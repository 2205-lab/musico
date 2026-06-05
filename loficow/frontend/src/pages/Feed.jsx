import { useState, useEffect, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Filter, TrendingUp, Clock, Users } from 'lucide-react'
import PostCard from '../components/feed/PostCard'
import CreatePost from '../components/feed/CreatePost'
import { api } from '../utils/api'
import { useAuth } from '../context/AuthContext'

const FILTERS = [
  { key: null,            label: 'All',     icon: TrendingUp },
  { key: 'track',         label: 'Tracks',  icon: Clock },
  { key: 'wip',           label: 'WIPs',    icon: Filter },
  { key: 'collab_request',label: 'Collabs', icon: Users },
]

export default function Feed() {
  const [posts,   setPosts]   = useState([])
  const [filter,  setFilter]  = useState(null)
  const [page,    setPage]    = useState(1)
  const [hasMore, setHasMore] = useState(true)
  const [loading, setLoading] = useState(false)
  const [params]  = useSearchParams()
  const { user }  = useAuth()

  const load = useCallback(async (reset = false) => {
    if (loading) return
    setLoading(true)
    try {
      const p = reset ? 1 : page
      const q = { page: p, limit: 10 }
      if (filter) q.type = filter
      const data = await api.get('/posts', q)
      if (reset) setPosts(data.posts)
      else       setPosts(prev => [...prev, ...data.posts])
      setHasMore(p < data.meta.pages)
      setPage(p + 1)
    } catch (e) { console.error(e) }
    finally { setLoading(false) }
  }, [filter, page, loading])

  useEffect(() => { setPage(1); setPosts([]); load(true) }, [filter])

  function handleCreated(post) { setPosts(p => [post, ...p]) }

  return (
    <div className="max-w-2xl mx-auto py-8 px-4 space-y-5 pb-24">
      {/* Create post */}
      {user && <CreatePost onCreated={handleCreated} />}

      {/* Filter tabs */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        {FILTERS.map(f => (
          <button
            key={f.key ?? 'all'}
            onClick={() => setFilter(f.key)}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium whitespace-nowrap
              transition-all duration-150 ${
                filter === f.key
                  ? 'bg-purple-500/15 text-purple-300 border border-purple-500/30'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-surface'
              }`}
          >
            <f.icon className="w-3.5 h-3.5" />
            {f.label}
          </button>
        ))}
      </div>

      {/* Posts */}
      {posts.length === 0 && !loading ? (
        <div className="card p-16 text-center">
          <p className="text-2xl mb-3">🌙</p>
          <p className="text-slate-400">Nothing here yet. Be the first to post!</p>
        </div>
      ) : (
        <div className="space-y-4">
          {posts.map(post => (
            <PostCard key={post.id} post={post} />
          ))}
        </div>
      )}

      {loading && (
        <div className="flex justify-center py-8">
          <div className="w-8 h-8 rounded-full border-2 border-purple-500/30 border-t-purple-500 animate-spin" />
        </div>
      )}

      {hasMore && !loading && posts.length > 0 && (
        <button onClick={() => load(false)} className="w-full btn-secondary text-sm py-3">
          Load more
        </button>
      )}
    </div>
  )
}
