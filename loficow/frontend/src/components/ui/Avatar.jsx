import { BadgeCheck } from 'lucide-react'

const sizes = {
  xs: 'w-6 h-6 text-xs',
  sm: 'w-8 h-8 text-sm',
  md: 'w-10 h-10 text-base',
  lg: 'w-14 h-14 text-xl',
  xl: 'w-20 h-20 text-2xl',
  '2xl': 'w-28 h-28 text-3xl',
}

export default function Avatar({ user, size = 'md', className = '', showVerified = false }) {
  const sizeClass = sizes[size] || sizes.md
  const letter = user?.display_name?.[0]?.toUpperCase() || user?.username?.[0]?.toUpperCase() || '?'

  return (
    <div className={`relative flex-shrink-0 ${className}`}>
      {user?.avatar_url ? (
        <img
          src={user.avatar_url}
          alt={user.display_name}
          className={`${sizeClass} rounded-full object-cover ring-2 ring-white/5`}
        />
      ) : (
        <div className={`${sizeClass} rounded-full bg-gradient-to-br from-purple-600 to-cyan-500
          flex items-center justify-center font-bold text-white ring-2 ring-white/5`}>
          {letter}
        </div>
      )}
      {showVerified && user?.verified ? (
        <BadgeCheck className="absolute -bottom-0.5 -right-0.5 w-4 h-4 text-cyan-400 bg-bg-primary rounded-full" />
      ) : null}
    </div>
  )
}
