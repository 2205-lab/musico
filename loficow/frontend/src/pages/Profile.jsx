import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { BadgeCheck, Music2, Users, Globe, MapPin, Link as LinkIcon } from 'lucide-react'
import { format } from 'date-fns'
import { api } from '../utils/api'
import { useAuth } from '../context/AuthContext'
import Avatar from '../components/ui/Avatar'
import PostCard from '../components/feed/PostCard'
import toast from 'react-hot-toast'

const TYPE_BADGES = {
  artist: { label: 'Artist', class: 'badge-purple' },
  label:  { label: 'Label',  class: 'badge-cyan' },
  both:   { label: 'Artist & Label', class: 'badge-amber' },
}

export default function Profile() {
  const { username } = useParams()
  const [profile, setProfile] = useState(null)
  const [posts,   setPosts]   = useState([])
  const [tab,     setTab]     = useState('tracks')
  const [loading, setLoading] = useState(true)
  const { user } = useAuth()

  useEffect(() => {
    setLoading(true)
    Promise.all([
      api.get(`/users/${username}/profile`),
      api.get('/posts', { user_id: '_', limit: 20 }),
    ]).then(([profileData]) => {
      setProfile(profileData.user)
      if (profileData.user) {
        api.get('/posts', { user_id: profileData.user.id, limit: 20 })
          .then(d => setPosts(d.posts || []))
      }
    }).catch(console.error).finally(() => setLoading(false))
  }, [username])

  async function toggleFollow() {
    if (!user) { toast.error('Sign in to follow'); return }
    const following = profile.is_following
    setProfile(p => ({
      ...p,
      is_following:   !following,
      followers_count: p.followers_count + (following ? -1 : 1),
    }))
    try {
      if (following) await api.delete(`/users/${profile.id}/follow`)
      else           await api.post(`/users/${profile.id}/follow`)
    } catch {
      setProfile(p => ({ ...p, is_following: following, followers_count: p.followers_count + (following ? 1 : -1) }))
    }
  }

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="w-8 h-8 rounded-full border-2 border-purple-500/30 border-t-purple-500 animate-spin" />
    </div>
  )

  if (!profile) return (
    <div className="text-center py-24 text-slate-500">User not found</div>
  )

  const typeBadge = TYPE_BADGES[profile.account_type] || TYPE_BADGES.artist

  return (
    <div className="max-w-3xl mx-auto pb-24">
      {/* Cover */}
      <div className="h-48 bg-gradient-to-r from-purple-900/60 via-bg-secondary to-cyan-900/40 relative rounded-b-2xl overflow-hidden">
        {profile.cover_url && (
          <img src={profile.cover_url} alt="" className="w-full h-full object-cover" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-bg-primary/60 to-transparent" />
      </div>

      {/* Profile info */}
      <div className="px-6">
        <div className="flex items-end justify-between -mt-12 mb-4">
          <Avatar user={profile} size="2xl" showVerified className="ring-4 ring-bg-primary rounded-full" />
          {profile.is_own_profile ? (
            <button className="btn-secondary text-sm">Edit Profile</button>
          ) : (
            <button
              onClick={toggleFollow}
              className={profile.is_following ? 'btn-secondary text-sm' : 'btn-primary text-sm'}
            >
              {profile.is_following ? 'Following' : 'Follow'}
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 mb-1">
          <h1 className="font-display font-bold text-2xl text-slate-100">{profile.display_name}</h1>
          {profile.verified && <BadgeCheck className="w-5 h-5 text-cyan-400" />}
          <span className={typeBadge.class}>{typeBadge.label}</span>
        </div>
        <p className="text-slate-500 mb-3">@{profile.username}</p>

        {profile.bio && (
          <p className="text-slate-300 text-sm leading-relaxed mb-4 max-w-xl">{profile.bio}</p>
        )}

        <div className="flex items-center flex-wrap gap-4 text-sm text-slate-500 mb-4">
          {profile.location && (
            <span className="flex items-center gap-1"><MapPin className="w-3.5 h-3.5" />{profile.location}</span>
          )}
          {profile.website && (
            <a href={profile.website} target="_blank" rel="noreferrer"
              className="flex items-center gap-1 hover:text-purple-400 transition-colors">
              <Globe className="w-3.5 h-3.5" />{profile.website.replace(/^https?:\/\//, '')}
            </a>
          )}
          <span>Joined {format(new Date(profile.created_at), 'MMM yyyy')}</span>
        </div>

        <div className="flex items-center gap-6 pb-5 border-b border-white/5">
          <div>
            <span className="font-bold text-slate-100">{profile.followers_count}</span>
            <span className="text-sm text-slate-500 ml-1.5">Followers</span>
          </div>
          <div>
            <span className="font-bold text-slate-100">{profile.following_count}</span>
            <span className="text-sm text-slate-500 ml-1.5">Following</span>
          </div>
          <div>
            <span className="font-bold text-slate-100">{profile.tracks_count}</span>
            <span className="text-sm text-slate-500 ml-1.5">Tracks</span>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 px-6 mt-4 border-b border-white/5">
        {['tracks','beats','collabs'].map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2.5 text-sm font-medium capitalize border-b-2 -mb-px transition-colors ${
              tab === t
                ? 'border-purple-500 text-purple-300'
                : 'border-transparent text-slate-500 hover:text-slate-300'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="px-6 pt-4 space-y-4">
        {tab === 'tracks' && (
          posts.filter(p => ['track','wip'].includes(p.post_type)).length === 0
            ? <div className="text-center py-16 text-slate-500">No tracks yet</div>
            : posts.filter(p => ['track','wip'].includes(p.post_type)).map(post => (
                <PostCard key={post.id} post={post} />
              ))
        )}
        {tab === 'beats' && (
          <div className="text-center py-16 text-slate-500">No beats listed yet</div>
        )}
        {tab === 'collabs' && (
          <div className="text-center py-16 text-slate-500">No collab posts yet</div>
        )}
      </div>
    </div>
  )
}
