const TRADITIONAL_CHINESE_MARKERS = /[這個們為麼沒還嗎對讓請謝說話買賣開關電腦網路臺灣鐘錶聽讀寫報學會圓]/u
const SIMPLIFIED_CHINESE_MARKERS = /[这们为么没还吗对让请谢谢说话买卖开关电脑网络台湾钟表听读写报学会圆]/u
const HAN_CHARACTERS = /\p{Script=Han}/u
const JAPANESE_KANA = /[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9f]/u
const KOREAN_HANGUL = /\p{Script=Hangul}/u

export const isTraditionalChineseTarget = (targetLanguage?: string): boolean => {
  const normalized = targetLanguage?.replace('_', '-').toLowerCase()
  return normalized === 'zh-hant' || normalized === 'zh-tw' || normalized === 'zh-hk' || normalized === 'zh-mo'
}

export const isLikelyTraditionalChinese = (text: string): boolean =>
  HAN_CHARACTERS.test(text) &&
  !JAPANESE_KANA.test(text) &&
  !KOREAN_HANGUL.test(text) &&
  TRADITIONAL_CHINESE_MARKERS.test(text) &&
  !SIMPLIFIED_CHINESE_MARKERS.test(text)
