(async () => {
  const spaceId = 9252628;
  const perPage = 100;
  const useUTC = true;
  const storageKey = `rc_cursor_${spaceId}`;   // 只存游标，不存数据

  // 续传：如果上次因报错/中断提前退出，把中断处的 id 填这里手动续传；
  // 留 null 则：若上次是正常读到停止边界结束，自动从最新消息重新开始；
  //           若上次是中断退出，自动从保存的 checkpoint 续传。
  const resumeFromId = null;

  // 停止边界（message id）：抓到 <= 这个 id 的消息就停止，只下载比它更新的消息。
  // 留 null 会弹出文件选择框，自动读取你选中的本地 ruleclassroom_*.json 存档，
  // 取里面最大的 id 作为边界；也可以手动填一个数字跳过弹窗。
  const manualStopAtMessageId = null;

  const runTag = new Date().toISOString().slice(11,16).replace(':','');  // 防止文件重名

  // ---------- 自动确定停止边界：从本地已下载的存档文件里找最大 id ----------
  function pickStopAtMessageId() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept = '.json';
      input.style.display = 'none';
      document.body.appendChild(input);
      input.addEventListener('change', async () => {
        let maxId = 0;
        let maxRec = null;
        for (const file of input.files) {
          try {
            const data = JSON.parse(await file.text());
            if (Array.isArray(data)) {
              for (const rec of data) {
                if (rec && typeof rec.id === 'number' && rec.id > maxId) { maxId = rec.id; maxRec = rec; }
              }
            }
          } catch (e) {
            console.warn(`跳过无法解析的文件 ${file.name}`, e.message);
          }
        }
        input.remove();
        resolve({ maxId, maxRec });
      }, { once: true });
      console.log('请选中当前目录下所有 ruleclassroom_*.json 存档文件（可多选），用于自动确定已下载到哪条消息；取消选择则视为本地无数据。');
      input.click();
    });
  }

  let stopAtMessageId = manualStopAtMessageId;
  if (stopAtMessageId == null) {
    const { maxId, maxRec } = await pickStopAtMessageId();
    stopAtMessageId = maxId;
    if (stopAtMessageId > 0) {
      console.log(`本地已有数据最新到 id=${stopAtMessageId}（${maxRec.created_at}），本次只抓取更新的消息`);
    } else {
      console.log('未选择本地文件或本地无数据，将抓取全部历史消息');
    }
  }

  // ---------- 游标恢复 ----------
  let ck = null;
  try { ck = JSON.parse(localStorage.getItem(storageKey)); } catch {}
  let maxMessageId = resumeFromId ?? ck?.maxMessageId ?? null;
  let page = ck?.page ?? 0;
  if (maxMessageId) console.log(`从 max_message_id=${maxMessageId} 开始（第 ${page} 页之后）`);

  const saveCursor = () => {
    try { localStorage.setItem(storageKey, JSON.stringify({ maxMessageId, page })); }
    catch (e) { console.warn('游标保存失败（不影响抓取）', e.message); }
  };

  const baseDelay = 800;
  const jitter = () => Math.random() * 500;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let fails = 0;
  const maxFails = 5;

  // ---------- 月份缓冲 ----------
  const monthKey = (iso) => {
    const d = new Date(iso);
    const y = useUTC ? d.getUTCFullYear() : d.getFullYear();
    const m = (useUTC ? d.getUTCMonth() : d.getMonth()) + 1;
    return `${y}-${String(m).padStart(2,'0')}`;
  };

  const buffer = new Map();     // monthKey -> messages[]
  const downloaded = [];
  let totalFetched = 0;

  async function downloadMonth(key) {
    const data = buffer.get(key);
    if (!data || !data.length) return;
    data.sort((a,b) => new Date(a.created_at) - new Date(b.created_at));
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ruleclassroom_${spaceId}_${key}_${runTag}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    console.log(`↓ ${a.download}（${data.length} 条，${data[0].created_at.slice(0,10)} ~ ${data[data.length-1].created_at.slice(0,10)}）`);
    downloaded.push({ 月份: key, 条数: data.length });
    buffer.delete(key);   // 释放内存
    await sleep(700);
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }

  // ---------- 抓取 ----------
  let completed = false;   // true = 正常读到停止边界/最早消息；false = 因报错/异常中断
  try {
    while (true) {
      const url = maxMessageId
        ? `/api/web/v1/spaces/${spaceId}/chats?per_page=${perPage}&max_message_id=${maxMessageId}`
        : `/api/web/v1/spaces/${spaceId}/chats?per_page=${perPage}`;

      let res;
      try {
        res = await fetch(url, { credentials: 'include' });
      } catch (e) {
        if (++fails > maxFails) { console.error('连续网络失败过多，停止'); break; }
        console.warn('网络错误，退避重试', e.message);
        await sleep(baseDelay * 2 ** fails);
        continue;
      }

      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get('Retry-After')) || 0;
        const wait = ra > 0 ? ra * 1000 : baseDelay * 2 ** (fails + 1);
        if (++fails > maxFails) { console.error(`连续 ${res.status} 过多，停止`); break; }
        console.warn(`${res.status}，等待 ${Math.round(wait/1000)}s`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) { console.error('请求失败', res.status, res.statusText); break; }

      fails = 0;
      const batch = await res.json();
      if (!Array.isArray(batch) || !batch.length) { console.log('已到最早一条消息'); completed = true; break; }

      page++;
      totalFetched += batch.length;

      // 分桶（跳过本地已经有的消息，只保留比停止边界更新的）
      for (const m of batch) {
        if (m.id <= stopAtMessageId) continue;
        const k = monthKey(m.created_at);
        if (!buffer.has(k)) buffer.set(k, []);
        buffer.get(k).push(m);
      }

      // 本批最早消息所在月之后的月份都已收完 → 立刻下载并释放
      const cutoffMonth = monthKey(batch[0].created_at);
      for (const k of [...buffer.keys()].filter(k => k > cutoffMonth).sort()) {
        await downloadMonth(k);
      }

      console.log(`第 ${page} 页：${batch.length} 条，累计 ${totalFetched}，本批 ${batch[0].created_at} ~ ${batch[batch.length-1].created_at}`);

      const minId = Math.min(...batch.map(m => m.id));
      if (maxMessageId !== null && minId >= maxMessageId) { console.log('id 未减小，停止'); break; }
      maxMessageId = minId - 1;
      saveCursor();

      if (minId <= stopAtMessageId) { console.log('已抓到本地已下载的最新消息，停止'); completed = true; break; }
      if (batch.length < perPage) { console.log('不足一页，已到最早消息'); completed = true; break; }
      await sleep(baseDelay + jitter());
    }
  } catch (e) {
    console.error('抓取中断：', e);
  } finally {
    // 剩余月份全部下载
    for (const k of [...buffer.keys()].sort().reverse()) await downloadMonth(k);
    console.log('===== 本次下载 =====');
    console.table(downloaded);
    if (completed) {
      try { localStorage.removeItem(storageKey); } catch (e) {}
      console.log('已正常读到本地已有的最新消息，游标已清除，下次运行会自动从最新消息重新开始');
    } else {
      console.log(`本次未读完，已保存续传游标：max_message_id=${maxMessageId}（下次运行会自动续传）`);
    }
  }
})();