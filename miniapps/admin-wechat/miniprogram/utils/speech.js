// 语音输入：长按说话 → 微信同声传译插件实时转写。
// 注意：转写结果只进「语音草稿」区，不直接当提示词用——必须经 AI 结构化
// （api.polishPrompt）或本地模板整理后才进生产任务，原始口语直接喂大模型效果很差。
// 插件不可用（未在公众平台添加/低版本基础库）时 available=false，页面上按钮置灰并给出指引。

let manager = null;
let checked = false;

function getManager() {
  if (checked) return manager;
  checked = true;
  try {
    // eslint-disable-next-line no-undef
    const plugin = requirePlugin('WechatSI');
    if (plugin && typeof plugin.getRecordRecognitionManager === 'function') {
      manager = plugin.getRecordRecognitionManager();
    }
  } catch (e) {
    manager = null; // 开发者工具未装插件 / 公众平台未添加：静默降级，不炸页面
  }
  return manager;
}

/**
 * 开始一次"按住说"识别。单次最长 60 秒，插件自动收尾。
 * @param {Object} cb { onInterim(文本), onFinal(文本), onError(消息) }
 */
function startHold(cb) {
  const m = getManager();
  if (!m) {
    cb.onError && cb.onError('未启用语音插件：请在微信公众平台「设置-第三方设置-插件管理」添加免费的「微信同声传译」');
    return false;
  }
  let lastInterim = '';
  let done = false;
  m.onStart = () => {};
  m.onRecognized = (res) => {
    done = true;
    cb.onFinal && cb.onFinal((res && res.result) || lastInterim || '');
  };
  m.onRecognizedInterim = (res) => {
    lastInterim = (res && res.result) || lastInterim;
    cb.onInterim && cb.onInterim(lastInterim);
  };
  m.onError = (res) => {
    done = true;
    cb.onError && cb.onError((res && res.ret_msg) || '没听清，按住再说一次');
  };
  m.onStop = (res) => {
    // stop() 后插件兜底回调：有结果走结果，没结果静默（用户可能只按了一下）。
    if (done) return;
    const text = (res && res.result) || lastInterim || '';
    cb.onFinal && cb.onFinal(text);
  };
  try {
    m.start({ lang: 'zh_CN' });
    return true;
  } catch (e) {
    cb.onError && cb.onError('录音启动失败：请在右上角「…」→设置里允许使用麦克风');
    return false;
  }
}

function stopHold() {
  const m = getManager();
  if (m) { try { m.stop(); } catch (e) { /* 没起来就无所谓 */ } }
}

module.exports = {
  available() { return !!getManager(); },
  startHold,
  stopHold,
};
