// Supabase Edge Function：報價需求送出後，寄 Email 給指定信箱。
// 部署：supabase functions deploy notify-quote
// 設定密鑰：supabase secrets set RESEND_API_KEY=... NOTIFY_TO=service@soloaudio.tw MAIL_FROM="報價系統 <quote@你的網域>"
// （寄信使用 Resend；寄件網域需先在 Resend 完成驗證。也可改成其他寄信服務。）
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
const money = (n: unknown) => 'NT$' + Math.round(Number(n) || 0).toLocaleString('zh-TW')

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const url = Deno.env.get('SUPABASE_URL')!
    const { quote_id } = await req.json()

    // 以呼叫者本人的身分讀取：只有看得到這張報價的人才能觸發通知（受 RLS 保護）
    const user = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    })
    const { data: q, error } = await user
      .from('quotes')
      .select('*, customer:profiles!quotes_customer_id_fkey(name,company_name,phone), quote_items(name_snapshot,quantity,line_total), quote_fees(name_snapshot,quantity,line_total)')
      .eq('id', quote_id)
      .single()
    if (error || !q) return new Response('not found', { status: 404, headers: cors })

    // 每張報價只寄一次
    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data: claimed } = await admin
      .from('quotes').update({ notified_at: new Date().toISOString() })
      .eq('id', quote_id).is('notified_at', null).select('id')
    if (!claimed?.length) return new Response('already notified', { headers: cors })

    const it = q.intake ?? {}
    const rows = [...q.quote_items, ...q.quote_fees]
      .map((i: any) => `<tr><td>${esc(i.name_snapshot)}</td><td>×${i.quantity}</td><td align="right">${money(i.line_total)}</td></tr>`).join('')
    const html = `
      <h3>新的${q.type === 'event' ? '活動演出' : '器材租賃'}詢價　${esc(q.quote_no)}</h3>
      <p>客戶：${esc(q.customer?.company_name || q.customer?.name)}　電話：${esc(q.customer?.phone)}<br>
      日期：${q.start_date}${q.end_date !== q.start_date ? ' ~ ' + q.end_date : ''}${q.type === 'event' ? '　場次：' + q.session_count : ''}<br>
      ${q.event_location ? '地點：' + esc(q.event_location) + '<br>' : ''}
      ${it.people ? '預估人數：' + esc(it.people) + '<br>' : ''}${it.needs?.length ? '需求：' + esc(it.needs.join('、')) + '<br>' : ''}
      ${it.brief ? '活動簡介：' + esc(it.brief) + '<br>' : ''}${q.requirements ? '說明：' + esc(q.requirements) + '<br>' : ''}
      ${q.signed_name ? '已簽名：' + esc(q.signed_name) : '尚未簽名'}</p>
      <table cellpadding="4" border="0">${rows}</table>
      <p><b>預估總額：${money(q.total)}</b>（僅供參考，最終價格以專人洽詢為主）</p>`

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${Deno.env.get('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: Deno.env.get('MAIL_FROM'), to: [Deno.env.get('NOTIFY_TO')], subject: `[新詢價] ${q.quote_no}`, html }),
    })
    if (!r.ok) {
      await admin.from('quotes').update({ notified_at: null }).eq('id', quote_id) // 寄信失敗，允許之後重試
      return new Response('mail failed', { status: 502, headers: cors })
    }
    return new Response('sent', { headers: cors })
  } catch (e) {
    return new Response(String(e), { status: 500, headers: cors })
  }
})
