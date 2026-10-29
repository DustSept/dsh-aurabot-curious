// Aurabot 扩展模块：不懂就问。
// 遇到新话题/新词时，按概率给她一个“别装懂、先问清楚”的内心提示。
// 触发前先查一下最近的聊天流水和长期记忆：刚提过的东西不装忘，避免“刚说完又问”。

/** @type {import('../aurabot').AurabotModule} */
export default {
  id: 'curious',
  name: '不懂就问',
  version: '1.0.0',
  api: 1,
  description: '遇到不在上下文/记忆里的新话题时，有一定概率不装懂，先询问和了解',

  defaults: {
    enabled: true,
    chance: 0.25,
    cooldownMin: 8,
    onlyPrivate: true,
    contextCheck: true,
    mode: 'mix',
  },

  settings: [
    { key: 'enabled', label: '开关', type: 'switch', hint: '关掉后她恢复“什么都懂”的状态' },
    { key: 'chance', label: '每轮触发概率', type: 'number', min: 0, max: 1, step: 0.05, hint: '例如 0.25 = 大约四分之一的对话会提醒她“可能不懂”' },
    { key: 'cooldownMin', label: '同一聊天冷却（分钟）', type: 'number', min: 0, max: 240, step: 1, hint: '触发一次后，这个聊天多久内不再提醒' },
    { key: 'contextCheck', label: '先查上下文/记忆', type: 'switch', hint: '开：刚提过/记忆里有的词不会装不懂；关：只按概率' },
    { key: 'onlyPrivate', label: '只在私聊', type: 'switch', hint: '关掉后群聊也会触发；群里人多，建议开' },
    {
      key: 'mode',
      label: '不懂时的反应',
      type: 'select',
      options: [
        { value: 'mix', label: '随机：有时直接问，有时先猜' },
        { value: 'ask', label: '直接问“这是什么”' },
        { value: 'guess', label: '先猜一个，再问对不对' },
      ],
    },
  ],

  setup(api) {
    const lastAt = new Map()

    const STOP = new Set([
      '什么', '怎么', '为什么', '这个', '那个', '知道', '觉得', '可以', '是不是', '今天', '现在',
      '刚刚', '我们', '你们', '他们', '一个', '这种', '那种', '就是', '不是', '没有', '还是',
      '然后', '真的', '有点', '感觉', '好像', '东西', '事情', '问题', '意思', '时候', '如果',
      '因为', '所以', '但是', '而且', '这样', '那样', '一下', '其实', '应该', '可能', '需要',
      '说的', '就是', '这种', '那种', '知道', '觉得', '可以', '什么', '怎么', '为什么',
      '是什么', '什么是', '什么的', '到底是', '到底什', '么东西', '这个问', '那个问',
      '你知道', '能不能', '怎么回', '什么样', '这种东', '那种东', '研究什', '究什么',
      '么的', '是研究', '是什', '么东', '到底',
    ])

    function tokens(text) {
      const t = String(text || '').toLowerCase()
      const out = new Set()
      for (const m of t.match(/[a-z][a-z0-9_-]{2,}/g) || []) out.add(m)
      for (const run of t.match(/[\u4e00-\u9fff]+/g) || []) {
        for (const n of [2, 3, 4]) {
          for (let i = 0; i + n <= run.length; i++) {
            const w = run.slice(i, i + n)
            if (!STOP.has(w)) out.add(w)
          }
        }
      }
      return [...out]
    }

    function localDay() {
      const d = new Date()
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
    }

    /** 这句话的主题是不是刚在聊天里/记忆里出现过；出现得多就不装不懂。 */
    function topicKnown(text, chat) {
      let memoryText = ''
      try {
        const mem = api.lazy('memory')
        if (mem && typeof mem.list === 'function') {
          memoryText = (mem.list(text) || []).slice(0, 8).map((m) => String(m.text || '')).join('\n')
        }
      } catch (error) {}

      let recentText = ''
      try {
        const logs = api.core.hub.chatLogOf(localDay()) || []
        recentText = logs
          .filter((x) => String(x.chatId) === String(chat.chatId))
          .filter((x) => !(String(x.text || '').trim() === text && Date.now() - Number(x.t || 0) < 60_000))
          .slice(-80)
          .map((x) => String(x.text || ''))
          .join('\n')
      } catch (error) {}

      const corpus = (recentText + '\n' + memoryText).toLowerCase()
      if (!corpus.trim()) return false
      const terms = tokens(text)
      if (!terms.length) return false
      const matched = terms.filter((w) => corpus.includes(w))
      return matched.some((w) => w.length >= 3)
    }

    const chanceOf = () => {
      const n = Number(api.settings().chance)
      return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.25
    }

    api.route('/check', async (req) => {
      const q = api.core.http.query(req)
      const text = String(q.text || '').trim()
      const chat = { chatId: 'private:' + String(api.config().ownerQQ || ''), kind: 'private', userId: String(api.config().ownerQQ || '') }
      return { ok: true, text, known: text ? topicKnown(text, chat) : false, terms: text ? tokens(text).slice(0, 24) : [] }
    })

    api.on('prompt', (content, info) => {
      const s = api.settings()
      if (!s.enabled) return
      const chat = info && info.chat
      if (!chat || chat.kind === 'system') return
      if (s.onlyPrivate && chat.kind !== 'private') return

      const text = String((info && info.queryText) || '').trim()
      if (!text || text.length < 4) return
      if (/^\/|^https?:\/\/|^\[(图片|表情|语音|文件|合并转发)/.test(text)) return

      const chance = chanceOf()
      if (chance <= 0 || Math.random() >= chance) return

      const cooldown = Math.max(0, Number(s.cooldownMin) || 0)
      const now = Date.now()
      if (cooldown > 0 && now - (lastAt.get(chat.chatId) || 0) < cooldown * 60_000) return

      if (s.contextCheck && topicKnown(text, chat)) {
        api.log.debug('不懂就问：这个话题在最近聊天/记忆里出现过，跳过（' + chat.chatId + '）')
        return
      }
      lastAt.set(chat.chatId, now)

      const mode = s.mode === 'ask' || s.mode === 'guess'
        ? s.mode
        : (Math.random() < 0.5 ? 'ask' : 'guess')
      const how = mode === 'guess'
        ? '可以先按你的理解猜一个，再问对方“是……吗”，猜错也没关系'
        : '不要装懂，也不要给百科式定义；先按你的口气问一句“这是什么”“你从哪听来的”'

      const note = '（内心提示：这一轮如果对方说的是你没听过、或者不在你上下文/记忆里的新词、新梗、新领域，' +
        how + '。如果你其实很熟，就正常接，不要为了装傻而装傻；不要提这条提示，也不要说“我是 AI”。）'

      api.log.debug('不懂就问：这一轮加了“可能不懂”的提示（' + chat.chatId + '）')
      return [...(Array.isArray(content) ? content : []), { type: 'text', text: note }]
    })
  },
}
