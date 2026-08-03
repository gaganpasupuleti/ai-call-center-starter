export const LISTEN_PROMPTS = Object.freeze({
  en: {
    stillThere:
      'Are you still there? You can say details, demo, callback, or not interested.',
    closingMaxTurns:
      'Thank you. Our counsellor will follow up with you shortly.',
    closingIdle: 'Thank you for your time. Goodbye.',
    closingPolite: 'Thank you for calling. Goodbye.',
    dtmfFallback:
      'Please use your keypad. Press 1 if interested, 2 for a callback, or 9 for an agent.',
  },
  te: {
    stillThere:
      'మీరు ఇంకా ఉన్నారా? వివరాలు, డెమో, కాల్‌బ్యాక్ లేదా ఆసక్తి లేదు అని చెప్పవచ్చు.',
    closingMaxTurns:
      'ధన్యవాదాలు. మా కౌన్సెలర్ త్వరలో మీతో సంప్రదిస్తారు.',
    closingIdle: 'మీ సమయానికి ధన్యవాదాలు. వీడ్కోలు.',
    closingPolite: 'కాల్ చేసినందుకు ధన్యవాదాలు. వీడ్కోలు.',
    dtmfFallback:
      'దయచేసి కీప్యాడ్ ఉపయోగించండి. ఆసక్తి ఉంటే 1, కాల్‌బ్యాక్ కావాలంటే 2, ఏజెంట్ కావాలంటే 9 నొక్కండి.',
  },
});

export function listenPrompt(language, key) {
  const lang = language === 'te' ? 'te' : 'en';
  return LISTEN_PROMPTS[lang][key] || LISTEN_PROMPTS.en[key];
}
