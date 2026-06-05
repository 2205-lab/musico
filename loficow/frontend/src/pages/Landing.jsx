import { Link } from 'react-router-dom'
import { Moon, Music2, Users, Send, Hash, Mic2, Star, ArrowRight, Play, Zap, Globe } from 'lucide-react'

const features = [
  { icon: Music2, title: 'Beat Marketplace',   desc: 'License and sell your beats. Set your own prices — basic, premium, exclusive.', color: 'text-purple-400', bg: 'bg-purple-500/10' },
  { icon: Hash,   title: 'Community Channels', desc: 'Discord-style rooms purpose-built for lofi creators. No noise, only vibes.', color: 'text-cyan-400',   bg: 'bg-cyan-500/10' },
  { icon: Send,   title: 'Demo Submissions',   desc: 'Artists submit directly to labels. Labels manage their inbox in one place.', color: 'text-amber-400',  bg: 'bg-amber-500/10' },
  { icon: Users,  title: 'Collab Finder',      desc: 'Find your next creative partner. Filter by style, vibe, and instruments.', color: 'text-green-400',  bg: 'bg-green-500/10' },
  { icon: Mic2,   title: 'Artist Profiles',    desc: 'Your complete portfolio — tracks, stats, collabs, and a bio the world can find.', color: 'text-rose-400',   bg: 'bg-rose-500/10' },
  { icon: Globe,  title: 'Global Feed',        desc: 'Stay up with every release, WIP drop, and lofi moment from artists you follow.', color: 'text-purple-400', bg: 'bg-purple-500/10' },
]

const stats = [
  { label: 'Lofi Artists', value: '12K+' },
  { label: 'Beats Listed', value: '40K+' },
  { label: 'Labels',       value: '200+' },
  { label: 'Daily Plays',  value: '500K+' },
]

export default function Landing() {
  return (
    <div className="min-h-screen bg-bg-primary overflow-x-hidden grain">
      {/* Nav */}
      <nav className="fixed top-0 left-0 right-0 z-50 glass-strong border-b border-white/5">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-brand flex items-center justify-center shadow-glow-purple">
              <Moon className="w-5 h-5 text-white" />
            </div>
            <span className="font-display font-bold text-xl gradient-text">LoficOW</span>
          </div>
          <div className="flex items-center gap-3">
            <Link to="/auth?mode=login" className="btn-ghost text-sm">Sign in</Link>
            <Link to="/auth?mode=register" className="btn-primary text-sm">Join Free</Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative pt-32 pb-24 px-6">
        {/* Background glow */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[800px] h-[500px]
            bg-purple-600/10 rounded-full blur-3xl" />
          <div className="absolute top-1/3 left-1/4 w-[400px] h-[400px]
            bg-cyan-600/8 rounded-full blur-3xl" />
        </div>

        <div className="relative max-w-4xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 badge-purple mb-6 text-sm py-1.5 px-4">
            <Zap className="w-3.5 h-3.5" />
            The home for lofi creators
          </div>

          <h1 className="font-display font-bold text-5xl md:text-7xl leading-tight text-balance mb-6">
            Where{' '}
            <span className="gradient-text">Lofi Artists</span>
            {' '}& Labels{' '}
            <span className="gradient-text-warm">Connect</span>
          </h1>

          <p className="text-lg text-slate-400 max-w-2xl mx-auto mb-10 leading-relaxed">
            LoficOW is the dedicated space for lofi music creators — share beats, find collabs,
            submit demos to labels, and build your audience. Leave Discord behind.
          </p>

          <div className="flex items-center justify-center gap-4 flex-wrap">
            <Link to="/auth?mode=register"
              className="btn-primary flex items-center gap-2 text-base px-8 py-3.5">
              Start for Free <ArrowRight className="w-4 h-4" />
            </Link>
            <Link to="/auth?mode=login"
              className="btn-secondary flex items-center gap-2 text-base px-8 py-3.5">
              <Play className="w-4 h-4" /> Explore Beats
            </Link>
          </div>
        </div>

        {/* Fake UI preview */}
        <div className="relative max-w-5xl mx-auto mt-20">
          <div className="glass rounded-2xl border border-white/8 overflow-hidden shadow-2xl">
            <div className="bg-surface-hover px-4 py-2.5 flex items-center gap-2 border-b border-white/5">
              <div className="w-3 h-3 rounded-full bg-rose-500/60" />
              <div className="w-3 h-3 rounded-full bg-amber-500/60" />
              <div className="w-3 h-3 rounded-full bg-green-500/60" />
              <span className="text-xs text-slate-500 ml-3">loficow.com/feed</span>
            </div>
            <div className="grid grid-cols-12 h-72">
              {/* Sidebar mini */}
              <div className="col-span-2 bg-bg-secondary border-r border-white/5 p-3 space-y-2">
                {['Feed','Explore','Channels','Beats','Collabs'].map(label => (
                  <div key={label} className={`text-xs px-2 py-1.5 rounded-lg ${label==='Feed' ? 'bg-purple-500/15 text-purple-300' : 'text-slate-500'}`}>
                    {label}
                  </div>
                ))}
              </div>
              {/* Feed */}
              <div className="col-span-7 p-4 space-y-3 overflow-hidden">
                {[
                  { user: 'lofi.jazz', type: 'Track Release', title: 'Midnight Coffee', bpm: 82, color: 'badge-purple' },
                  { user: 'calmwaves', type: 'WIP',           title: 'Late Night Study', bpm: 75, color: 'badge-amber' },
                  { user: 'sakura_lo', type: 'Collab',        title: null, bpm: null, color: 'badge-green' },
                ].map((p, i) => (
                  <div key={i} className="glass rounded-xl p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <div className={`w-7 h-7 rounded-full bg-gradient-to-br ${['from-purple-600 to-cyan-500','from-amber-500 to-rose-500','from-green-500 to-cyan-400'][i]}`} />
                      <span className="text-xs font-medium text-slate-200">@{p.user}</span>
                      <span className={`${p.color} ml-auto`}>{p.type}</span>
                    </div>
                    {p.title && <div className="text-xs text-slate-400 mb-2">{p.title} {p.bpm && `· ${p.bpm} BPM`}</div>}
                    <div className="h-1 bg-surface-active rounded-full"><div className={`h-full bg-gradient-to-r from-purple-500 to-cyan-400 rounded-full`} style={{width:`${[65,40,20][i]}%`}}/></div>
                  </div>
                ))}
              </div>
              {/* Right panel */}
              <div className="col-span-3 border-l border-white/5 p-3 space-y-3">
                <div className="text-xs text-slate-500 font-medium">Trending Beats</div>
                {['tokyo rain','cozy 3am','clouds'].map((b,i)=>(
                  <div key={b} className="flex items-center gap-2">
                    <div className={`w-8 h-8 rounded-lg bg-gradient-to-br ${['from-purple-800 to-purple-600','from-cyan-800 to-cyan-600','from-amber-800 to-amber-600'][i]}`}/>
                    <div>
                      <p className="text-xs text-slate-300">{b}</p>
                      <p className="text-xs text-slate-600">{[82,76,90][i]} BPM</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Stats */}
      <section className="py-16 px-6 border-y border-white/5">
        <div className="max-w-4xl mx-auto grid grid-cols-2 md:grid-cols-4 gap-8">
          {stats.map(s => (
            <div key={s.label} className="text-center">
              <div className="font-display font-bold text-4xl gradient-text mb-1">{s.value}</div>
              <div className="text-sm text-slate-500">{s.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Features */}
      <section className="py-24 px-6">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="font-display font-bold text-4xl text-slate-100 mb-4">
              Everything a lofi creator needs
            </h2>
            <p className="text-slate-400 max-w-xl mx-auto">
              Built specifically for the lofi community — not a generic platform with lofi tagged on.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {features.map(f => (
              <div key={f.title} className="card card-hover p-6 group">
                <div className={`w-12 h-12 rounded-xl ${f.bg} flex items-center justify-center mb-4
                  group-hover:scale-110 transition-transform`}>
                  <f.icon className={`w-6 h-6 ${f.color}`} />
                </div>
                <h3 className="font-semibold text-slate-100 mb-2">{f.title}</h3>
                <p className="text-sm text-slate-400 leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-24 px-6">
        <div className="max-w-2xl mx-auto text-center">
          <div className="card p-12 relative overflow-hidden">
            <div className="absolute inset-0 bg-purple-glow pointer-events-none" />
            <Moon className="w-12 h-12 mx-auto mb-6 text-purple-400 animate-float" />
            <h2 className="font-display font-bold text-4xl mb-4">
              Ready to leave Discord?
            </h2>
            <p className="text-slate-400 mb-8">
              Join thousands of lofi artists and labels already building their community on LoficOW.
            </p>
            <Link to="/auth?mode=register" className="btn-primary text-base px-10 py-3.5 inline-flex items-center gap-2">
              Create Your Profile <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/5 py-8 px-6">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Moon className="w-4 h-4 text-purple-400" />
            <span className="text-sm text-slate-500">LoficOW © 2025</span>
          </div>
          <div className="flex gap-6 text-sm text-slate-500">
            <a href="#" className="hover:text-slate-300">About</a>
            <a href="#" className="hover:text-slate-300">Privacy</a>
            <a href="#" className="hover:text-slate-300">Terms</a>
          </div>
        </div>
      </footer>
    </div>
  )
}
