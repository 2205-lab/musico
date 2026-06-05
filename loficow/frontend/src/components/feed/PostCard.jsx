import { useState } from 'react'
import { Heart, MessageCircle, Share2, Music2, Wrench, Lightbulb, Users, BadgeCheck } from 'lucide-react'
import { Link } from 'react-router-dom'
import { formatDistanceToNow } from 'date-fns'
import Avatar from '../ui/Avatar'
import AudioPlayer from '../ui/AudioPlayer'
import { api } from '../../utils/api'
import { useAuth } from '../../context/AuthContext'
import toast from 'react-hot-toast'

const typeConfig = {
  track:         { icon: Music2,      label: 'Track',     color: 'badge-purple' },
  wip:           { icon: Wrench,      label: 'WIP',       color: 'badge-amber' },
  thought:       { icon: Lightbulb,   label: 'Thought',   color: 'badge-cyan' },
  collab_request:{ icon: Users,       label: 'Collab',    color: 'badge-green' },
}

export default function PostCard({ post: initial, onUpdate }) {
  const [post, setPost] = useState(initial)
  const [showComments, setShowComments] = useState(false)
  const [comments, setComments]         = useState([])
  const [commentText, setCommentText]   = useState('')
  const { user } = useAuth()

  const type = typeConfig[post.post_type] || typeConfig.thought

  async function toggleLike() {
    if (!user) { toast.error('Sign in to like posts'); return }
    const liked = post.is_liked
    setPost(p => ({ ...p, is_liked: !liked, likes_count: p.likes_count + (liked ? -1 : 1) }))
    try {
      if (liked) await api.delete(`/posts/${post.id}/like`)
      else       await api.post(`/posts/${post.id}/like`)
    } catch {
      setPost(p => ({ ...p, is_liked: liked, likes_count: p.likes_count + (liked ? 1 : -1) }))
    }
  }

  async function loadComments() {
    if (!showComments) {
      const data = await api.get(`/posts/${post.id}/comments`).catch(() => ({ comments: [] }))
      setComments(data.comments || [])
    }
    setShowComments(v => !v)
  }

  async function submitComment(e) {
    e.preventDefault()
    if (!commentText.trim() || !user) return
    try {
      const data = await api.post(`/posts/${post.id}/comment`, { content: commentText })
      setComments(c => [...c, data.comment])
      setPost(p => ({ ...p, comments_count: p.comments_count + 1 }))
      setCommentText('')
    } catch (err) {
      toast.error(err.message)
    }
  }

  function share() {
    navigator.clipboard.writeText(window.location.origin + `/post/${post.id}`)
    toast.success('Link copied!')
  }

  return (
    <article className="card card-hover p-5 animate-fade-in">
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <Link to={`/profile/${post.username}`} className="flex items-center gap-3 group">
          <Avatar user={post} size="sm" />
          <div>
            <div className="flex items-center gap-1">
              <span className="text-sm font-semibold text-slate-100 group-hover:text-purple-300 transition-colors">
                {post.display_name}
              </span>
              {post.verified ? <BadgeCheck className="w-3.5 h-3.5 text-cyan-400" /> : null}
            </div>
            <span className="text-xs text-slate-500">@{post.username}</span>
          </div>
        </Link>
        <div className="flex items-center gap-2">
          <span className={`${type.color}`}>
            <type.icon className="w-3 h-3" />{type.label}
          </span>
          <span className="text-xs text-slate-600">
            {formatDistanceToNow(new Date(post.created_at), { addSuffix: true })}
          </span>
        </div>
      </div>

      {/* Content */}
      {post.content && (
        <p className="text-slate-300 text-sm leading-relaxed mb-3 whitespace-pre-wrap">{post.content}</p>
      )}

      {/* Audio track */}
      {post.audio_url && (
        <div className="glass rounded-xl p-3 mb-3">
          {(post.track_title || post.cover_url) && (
            <div className="flex items-center gap-3 mb-3">
              {post.cover_url && (
                <img src={post.cover_url} alt="" className="w-12 h-12 rounded-lg object-cover" />
              )}
              <div>
                {post.track_title && (
                  <p className="text-sm font-semibold text-slate-100">{post.track_title}</p>
                )}
                <div className="flex items-center gap-2 mt-0.5">
                  {post.track_bpm  && <span className="badge-purple text-xs">{post.track_bpm} BPM</span>}
                  {post.track_key  && <span className="badge-cyan   text-xs">{post.track_key}</span>}
                </div>
              </div>
            </div>
          )}
          <AudioPlayer track={post} />
        </div>
      )}

      {/* Tags */}
      {post.tags && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {post.tags.split(',').map(t => (
            <span key={t} className="text-xs text-purple-400 hover:text-purple-300 cursor-pointer">
              #{t.trim()}
            </span>
          ))}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-1 pt-2 border-t border-white/5">
        <button
          onClick={toggleLike}
          className={`btn-ghost flex items-center gap-1.5 text-xs ${post.is_liked ? 'text-rose-400' : ''}`}
        >
          <Heart className={`w-4 h-4 ${post.is_liked ? 'fill-rose-400' : ''}`} />
          {post.likes_count > 0 && <span>{post.likes_count}</span>}
        </button>
        <button onClick={loadComments} className="btn-ghost flex items-center gap-1.5 text-xs">
          <MessageCircle className="w-4 h-4" />
          {post.comments_count > 0 && <span>{post.comments_count}</span>}
        </button>
        <button onClick={share} className="btn-ghost flex items-center gap-1.5 text-xs ml-auto">
          <Share2 className="w-4 h-4" />
        </button>
      </div>

      {/* Comments */}
      {showComments && (
        <div className="mt-4 space-y-3 animate-slide-up">
          {comments.map(c => (
            <div key={c.id} className="flex items-start gap-2">
              <Avatar user={c} size="xs" />
              <div className="flex-1 glass rounded-xl px-3 py-2">
                <span className="text-xs font-medium text-purple-300">{c.display_name}</span>
                <p className="text-xs text-slate-300 mt-0.5">{c.content}</p>
              </div>
            </div>
          ))}
          {user && (
            <form onSubmit={submitComment} className="flex items-center gap-2">
              <Avatar user={user} size="xs" />
              <input
                value={commentText}
                onChange={e => setCommentText(e.target.value)}
                placeholder="Add a comment..."
                className="input text-xs py-2 flex-1"
              />
            </form>
          )}
        </div>
      )}
    </article>
  )
}
