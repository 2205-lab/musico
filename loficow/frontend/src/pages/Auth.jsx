import { useState, useEffect } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Moon, Eye, EyeOff, Music2, Users } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import toast from 'react-hot-toast'

export default function Auth() {
  const [params] = useSearchParams()
  const [isLogin, setIsLogin] = useState(params.get('mode') !== 'register')
  const [form, setForm] = useState({ username:'', email:'', password:'', display_name:'', account_type:'artist' })
  const [showPass, setShowPass] = useState(false)
  const [loading, setLoading] = useState(false)
  const { login, register, user } = useAuth()
  const navigate = useNavigate()

  useEffect(() => { if (user) navigate('/feed') }, [user])
  useEffect(() => { setIsLogin(params.get('mode') !== 'register') }, [params])

  function field(key) {
    return { value: form[key], onChange: e => setForm(f => ({ ...f, [key]: e.target.value })) }
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setLoading(true)
    try {
      if (isLogin) {
        await login({ login: form.email || form.username, password: form.password })
      } else {
        await register(form)
      }
      toast.success(isLogin ? 'Welcome back! 🌙' : 'Welcome to LoficOW! 🎵')
      navigate('/feed')
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-bg-primary flex items-center justify-center px-4 grain">
      {/* Glow */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px]
          bg-purple-600/8 rounded-full blur-3xl" />
      </div>

      <div className="relative w-full max-w-md">
        {/* Logo */}
        <Link to="/" className="flex items-center justify-center gap-3 mb-8">
          <div className="w-10 h-10 rounded-xl bg-gradient-brand flex items-center justify-center shadow-glow-purple">
            <Moon className="w-5 h-5 text-white" />
          </div>
          <span className="font-display font-bold text-2xl gradient-text">LoficOW</span>
        </Link>

        <div className="card p-8">
          <h2 className="font-display font-bold text-2xl text-slate-100 text-center mb-2">
            {isLogin ? 'Welcome back' : 'Join LoficOW'}
          </h2>
          <p className="text-slate-500 text-center text-sm mb-8">
            {isLogin ? 'Sign in to your account' : 'Create your free account today'}
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            {!isLogin && (
              <>
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1.5">Display Name</label>
                  <input {...field('display_name')} placeholder="Your artist name" className="input" required />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1.5">Username</label>
                  <input {...field('username')} placeholder="@yourhandle" className="input" required />
                </div>
              </>
            )}
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">
                {isLogin ? 'Email or Username' : 'Email'}
              </label>
              <input {...field('email')} type={isLogin ? 'text' : 'email'}
                placeholder={isLogin ? 'email or @username' : 'you@example.com'}
                className="input" required />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">Password</label>
              <div className="relative">
                <input {...field('password')} type={showPass ? 'text' : 'password'}
                  placeholder="••••••••" className="input pr-10" required />
                <button type="button" onClick={() => setShowPass(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300">
                  {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {!isLogin && (
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5">I am a...</label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { value: 'artist', icon: Music2, label: 'Artist' },
                    { value: 'label',  icon: Users,  label: 'Label' },
                    { value: 'both',   icon: Moon,   label: 'Both' },
                  ].map(t => (
                    <button
                      key={t.value}
                      type="button"
                      onClick={() => setForm(f => ({ ...f, account_type: t.value }))}
                      className={`flex flex-col items-center gap-1.5 p-3 rounded-xl border text-xs font-medium transition-all ${
                        form.account_type === t.value
                          ? 'border-purple-500 bg-purple-500/15 text-purple-300'
                          : 'border-white/8 text-slate-400 hover:border-white/15'
                      }`}
                    >
                      <t.icon className="w-5 h-5" />
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <button type="submit" disabled={loading} className="btn-primary w-full text-base py-3 mt-2">
              {loading
                ? 'Please wait...'
                : isLogin ? 'Sign In' : 'Create Account'}
            </button>
          </form>

          <p className="text-center text-sm text-slate-500 mt-6">
            {isLogin ? "Don't have an account?" : 'Already have an account?'}{' '}
            <button
              onClick={() => setIsLogin(v => !v)}
              className="text-purple-400 hover:text-purple-300 font-medium"
            >
              {isLogin ? 'Sign up free' : 'Sign in'}
            </button>
          </p>
        </div>
      </div>
    </div>
  )
}
