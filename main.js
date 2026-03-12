/*
 * TTS Reader Plugin for Obsidian
 * 문서를 소리내어 읽어주는 플러그인
 * 한국어/영어/한자 지원, 모바일 호환
 *
 * Desktop: Web Speech API (speechSynthesis)
 * Mobile: Google Translate TTS (Audio 재생)
 */

"use strict";

const obsidian = require("obsidian");

// ─── 마크다운 → 순수 텍스트 변환 ───
function stripMarkdown(text) {
  return text
    .replace(/^---[\s\S]*?---\n*/m, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]*`/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^|\]]*\|)?([^\]]*)\]\]/g, "$2")
    .replace(/<[^>]+>/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
    .replace(/_{1,3}([^_]+)_{1,3}/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/==([^=]+)==/g, "$1")
    .replace(/^>\s?/gm, "")
    .replace(/^[-*_]{3,}\s*$/gm, "")
    .replace(/^[\s]*[-*+]\s+/gm, "")
    .replace(/^[\s]*\d+\.\s+/gm, "")
    .replace(/\[[ x]\]\s*/gi, "")
    .replace(/#[^\s#]+/g, "")
    .replace(/^\[![\w]+\][-+]?\s*/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─── 기본 설정 ───
const DEFAULT_SETTINGS = {
  rate: 1.0,
  pitch: 1.0,
  voiceName: "",
  lang: "ko",
  ttsServerUrl: "http://100.69.168.49:8130",
  edgeTtsVoice: "ko-KR-SunHiNeural",
};

// ─── Edge TTS 서버 엔진 (모바일용) ───
// PC의 Edge TTS 서버에 요청 → 오디오 다운로드 → AudioContext로 재생
class EdgeTtsEngine {
  constructor(settings) {
    this.settings = settings;
    this.audioCtx = null;
    this.source = null;
    this.isPlaying = false;
    this.isPaused = false;
    this.chunks = [];
    this.currentIndex = 0;
    this.onFinishCallback = null;
    this.onErrorCallback = null;
  }

  splitText(text, maxLen) {
    const chunks = [];
    const sentences = text.split(/(?<=[.?!。！？\n,，])\s*/);
    let current = "";
    for (const s of sentences) {
      if (!s.trim()) continue;
      if ((current + s).length > maxLen && current) {
        chunks.push(current.trim());
        current = s;
      } else {
        current = current ? current + " " + s : s;
      }
    }
    if (current.trim()) chunks.push(current.trim());
    const result = [];
    for (const c of chunks) {
      if (c.length <= maxLen) {
        result.push(c);
      } else {
        for (let i = 0; i < c.length; i += maxLen) {
          result.push(c.substring(i, i + maxLen));
        }
      }
    }
    return result.length > 0 ? result : [text.substring(0, maxLen)];
  }

  speak(text, onFinish, onError) {
    this.stop();
    // Edge TTS는 긴 텍스트도 가능하지만, 청크로 나눠서 연속 재생
    this.chunks = this.splitText(text, 500);
    this.currentIndex = 0;
    this.isPlaying = true;
    this.isPaused = false;
    this.onFinishCallback = onFinish;
    this.onErrorCallback = onError;
    this.playNext();
  }

  async playNext() {
    if (!this.isPlaying || this.currentIndex >= this.chunks.length) {
      this.isPlaying = false;
      if (this.onFinishCallback) this.onFinishCallback();
      return;
    }

    const chunk = this.chunks[this.currentIndex];
    const serverUrl = this.settings.ttsServerUrl || "http://100.69.168.49:8130";
    const voice = this.settings.edgeTtsVoice || "ko-KR-SunHiNeural";

    // 속도 변환 (1.0 → "+0%", 1.5 → "+50%", 0.75 → "-25%")
    const ratePercent = Math.round((this.settings.rate - 1.0) * 100);
    const rateStr = (ratePercent >= 0 ? "+" : "") + ratePercent + "%";

    try {
      const response = await obsidian.requestUrl({
        url: serverUrl + "/tts",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: chunk, voice: voice, rate: rateStr }),
      });

      // AudioContext로 재생
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const arrayBuf = response.arrayBuffer.slice(0);
      const audioBuffer = await this.audioCtx.decodeAudioData(arrayBuf);

      this.source = this.audioCtx.createBufferSource();
      this.source.buffer = audioBuffer;
      this.source.connect(this.audioCtx.destination);

      this.source.onended = () => {
        this.currentIndex++;
        if (this.isPlaying && !this.isPaused) {
          this.playNext();
        }
      };

      this.source.start(0);

    } catch (e) {
      console.error("Edge TTS error:", e);
      if (this.currentIndex === 0) {
        // 첫 청크에서 실패하면 서버 연결 문제
        if (this.onErrorCallback) {
          this.onErrorCallback("TTS 서버 연결 실패\n" + (this.settings.ttsServerUrl || "") + "\n" + e.message);
        }
        this.isPlaying = false;
        return;
      }
      // 중간 청크 실패는 건너뛰기
      this.currentIndex++;
      if (this.isPlaying) this.playNext();
    }
  }

  pause() {
    if (this.audioCtx && this.isPlaying) {
      this.audioCtx.suspend();
      this.isPaused = true;
    }
  }

  resume() {
    if (this.audioCtx && this.isPaused) {
      this.audioCtx.resume();
      this.isPaused = false;
    }
  }

  stop() {
    this.isPlaying = false;
    this.isPaused = false;
    if (this.source) {
      try { this.source.stop(); } catch (e) {}
      this.source = null;
    }
    if (this.audioCtx) {
      try { this.audioCtx.close(); } catch (e) {}
      this.audioCtx = null;
    }
    this.chunks = [];
    this.currentIndex = 0;
  }
}

// ─── Web Speech API 엔진 (데스크탑용) ───
class WebSpeechEngine {
  constructor(settings) {
    this.settings = settings;
    this.synth = window.speechSynthesis;
    this.utterance = null;
    this.chunks = [];
    this.currentIndex = 0;
    this.isPlaying = false;
    this.isPaused = false;
    this.onFinishCallback = null;
    this.onErrorCallback = null;
  }

  splitText(text, maxLen) {
    const chunks = [];
    const sentences = text.split(/(?<=[.?!。！？\n])\s*/);
    let current = "";
    for (const s of sentences) {
      if (!s.trim()) continue;
      if ((current + " " + s).length > maxLen && current) {
        chunks.push(current.trim());
        current = s;
      } else {
        current = current ? current + " " + s : s;
      }
    }
    if (current.trim()) chunks.push(current.trim());
    if (chunks.length === 0) {
      for (let i = 0; i < text.length; i += maxLen) {
        chunks.push(text.substring(i, i + maxLen));
      }
    }
    return chunks;
  }

  speak(text, onFinish, onError) {
    this.stop();
    this.chunks = this.splitText(text, 200);
    this.currentIndex = 0;
    this.isPlaying = true;
    this.isPaused = false;
    this.onFinishCallback = onFinish;
    this.onErrorCallback = onError;
    this.playNext();
  }

  playNext() {
    if (!this.isPlaying || this.currentIndex >= this.chunks.length) {
      this.isPlaying = false;
      if (this.onFinishCallback) this.onFinishCallback();
      return;
    }

    const chunk = this.chunks[this.currentIndex];
    this.utterance = new SpeechSynthesisUtterance(chunk);
    this.utterance.rate = this.settings.rate || 1.0;
    this.utterance.pitch = this.settings.pitch || 1.0;
    this.utterance.lang = "ko-KR";

    if (this.settings.voiceName) {
      const voices = this.synth.getVoices();
      const voice = voices.find((v) => v.name === this.settings.voiceName);
      if (voice) {
        this.utterance.voice = voice;
        this.utterance.lang = voice.lang;
      }
    }

    this.utterance.onend = () => {
      this.currentIndex++;
      if (this.isPlaying && !this.isPaused) {
        this.playNext();
      }
    };

    this.utterance.onerror = (event) => {
      if (event.error !== "canceled" && event.error !== "interrupted") {
        if (this.onErrorCallback) this.onErrorCallback(event.error);
      }
      this.stop();
    };

    this.synth.speak(this.utterance);
  }

  pause() {
    if (this.isPlaying) {
      this.synth.pause();
      this.isPaused = true;
    }
  }

  resume() {
    if (this.isPaused) {
      this.synth.resume();
      this.isPaused = false;
    }
  }

  stop() {
    this.isPlaying = false;
    this.isPaused = false;
    try { this.synth.cancel(); } catch (e) {}
    this.utterance = null;
    this.chunks = [];
    this.currentIndex = 0;
  }
}

// ─── 메인 플러그인 ───
class TtsReaderPlugin extends obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.settings = Object.assign({}, DEFAULT_SETTINGS);
    this.engine = null;
    this.statusBarEl = null;
    this.ribbonPlayEl = null;
    this.useEdgeTts = false;
  }

  async onload() {
    await this.loadSettings();

    // 엔진 선택: speechSynthesis 있으면 WebSpeech, 없으면 Edge TTS 서버
    if (typeof window !== "undefined" && window.speechSynthesis) {
      this.engine = new WebSpeechEngine(this.settings);
      this.useEdgeTts = false;
    } else {
      this.engine = new EdgeTtsEngine(this.settings);
      this.useEdgeTts = true;
    }

    // 리본 아이콘
    this.ribbonPlayEl = this.addRibbonIcon("audio-lines", "TTS: 문서 읽기", () => {
      if (this.engine.isPlaying) {
        this.stopReading();
      } else {
        this.readDocument();
      }
    });

    // 상태바
    this.statusBarEl = this.addStatusBarItem();
    this.updateStatusBar();

    // 명령어
    this.addCommand({
      id: "read-document",
      name: "전체 문서 읽기",
      callback: () => this.readDocument(),
    });

    this.addCommand({
      id: "read-selection",
      name: "선택 텍스트 읽기",
      callback: () => {
        const view = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
        if (!view) {
          new obsidian.Notice("열린 마크다운 문서가 없습니다");
          return;
        }
        let selection = "";
        try { if (view.editor) selection = view.editor.getSelection(); } catch (e) {}
        if (selection) {
          this.readText(selection);
        } else {
          new obsidian.Notice("텍스트를 선택해주세요");
        }
      },
    });

    this.addCommand({
      id: "pause-resume",
      name: "일시정지 / 다시 재생",
      callback: () => this.togglePauseResume(),
    });

    this.addCommand({
      id: "stop-reading",
      name: "읽기 중지",
      callback: () => this.stopReading(),
    });

    this.addCommand({
      id: "rate-up",
      name: "속도 올리기 (+0.25)",
      callback: () => this.adjustRate(0.25),
    });

    this.addCommand({
      id: "rate-down",
      name: "속도 내리기 (-0.25)",
      callback: () => this.adjustRate(-0.25),
    });

    this.addCommand({
      id: "tts-diagnose",
      name: "TTS 진단",
      callback: () => this.diagnose(),
    });

    this.addSettingTab(new TtsSettingTab(this.app, this));
    console.log("TTS Reader loaded (engine: " + (this.useEdgeTts ? "Edge TTS 서버" : "Web Speech") + ")");
  }

  onunload() {
    this.stopReading();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    // 엔진 설정 동기화
    if (this.engine) {
      this.engine.settings = this.settings;
    }
  }

  diagnose() {
    const lines = [];
    lines.push("=== TTS 진단 ===");
    const isMobile = obsidian.Platform && obsidian.Platform.isMobile;
    lines.push("플랫폼: " + (isMobile ? "모바일" : "데스크탑"));
    lines.push("speechSynthesis: " + (window.speechSynthesis ? "있음" : "없음"));
    lines.push("엔진: " + (this.useEdgeTts ? "Edge TTS 서버" : "Web Speech"));
    if (this.useEdgeTts) {
      lines.push("서버: " + (this.settings.ttsServerUrl || "미설정"));
      lines.push("음성: " + (this.settings.edgeTtsVoice || "미설정"));
    }
    lines.push("AudioContext: " + (window.AudioContext || window.webkitAudioContext ? "있음" : "없음"));

    if (!this.useEdgeTts && window.speechSynthesis) {
      const voices = window.speechSynthesis.getVoices();
      lines.push("음성 수: " + voices.length);
      const ko = voices.filter((v) => v.lang.startsWith("ko"));
      lines.push("한국어 음성: " + ko.length);
    }

    const view = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
    lines.push("활성 뷰: " + (view ? "있음" : "없음"));
    if (view) {
      lines.push("에디터: " + (view.editor ? "있음" : "없음"));
      lines.push("파일: " + (view.file ? view.file.name : "없음"));
    }

    new obsidian.Notice(lines.join("\n"), 15000);
  }

  // ─── 문서 읽기 ───
  readDocument() {
    const view = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
    if (!view) {
      new obsidian.Notice("열린 마크다운 문서가 없습니다");
      return;
    }

    let text = "";
    try { if (view.editor) text = view.editor.getValue(); } catch (e) {}

    if (!text) {
      try {
        const file = view.file;
        if (file) {
          this.app.vault.cachedRead(file).then((content) => {
            if (content && content.trim()) {
              this.readText(content);
            } else {
              new obsidian.Notice("문서가 비어있습니다");
            }
          }).catch((e) => new obsidian.Notice("파일 읽기 실패: " + e.message));
          return;
        }
      } catch (e) {
        new obsidian.Notice("문서 읽기 실패: " + e.message);
        return;
      }
    }

    if (!text.trim()) {
      new obsidian.Notice("문서가 비어있습니다");
      return;
    }
    this.readText(text);
  }

  readText(rawText) {
    this.stopReading();

    const text = stripMarkdown(rawText);
    if (!text) {
      new obsidian.Notice("읽을 내용이 없습니다");
      return;
    }

    const engineName = this.useEdgeTts ? "Edge TTS 서버" : "Web Speech";
    new obsidian.Notice("읽기 시작 (" + engineName + ")");
    this.updateStatusBar();
    this.updateRibbonIcon();

    this.engine.speak(
      text,
      () => {
        // 완료
        this.updateStatusBar();
        this.updateRibbonIcon();
        new obsidian.Notice("읽기 완료");
      },
      (err) => {
        // 오류
        new obsidian.Notice("TTS 오류: " + err, 5000);
        this.updateStatusBar();
        this.updateRibbonIcon();
      }
    );

    this.updateStatusBar();
    this.updateRibbonIcon();
  }

  togglePauseResume() {
    if (!this.engine.isPlaying) {
      this.readDocument();
      return;
    }
    if (this.engine.isPaused) {
      this.engine.resume();
      new obsidian.Notice("다시 재생");
    } else {
      this.engine.pause();
      new obsidian.Notice("일시정지");
    }
    this.updateStatusBar();
  }

  stopReading() {
    if (this.engine) this.engine.stop();
    this.updateStatusBar();
    this.updateRibbonIcon();
  }

  adjustRate(delta) {
    this.settings.rate = Math.max(0.25, Math.min(4.0, this.settings.rate + delta));
    this.saveSettings();
    new obsidian.Notice("속도: " + this.settings.rate.toFixed(2) + "x");
  }

  updateStatusBar() {
    if (!this.statusBarEl) return;
    const playing = this.engine && this.engine.isPlaying;
    const paused = this.engine && this.engine.isPaused;
    if (playing && paused) {
      this.statusBarEl.setText("TTS ⏸ " + this.settings.rate.toFixed(2) + "x");
    } else if (playing) {
      this.statusBarEl.setText("TTS ▶ " + this.settings.rate.toFixed(2) + "x");
    } else {
      this.statusBarEl.setText("TTS " + this.settings.rate.toFixed(2) + "x");
    }
  }

  updateRibbonIcon() {
    if (!this.ribbonPlayEl) return;
    const playing = this.engine && this.engine.isPlaying;
    this.ribbonPlayEl.setAttribute("aria-label", playing ? "TTS: 읽기 중지" : "TTS: 문서 읽기");
  }
}

// ─── 설정 탭 ───
class TtsSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "TTS Reader 설정" });

    // 현재 엔진 표시
    containerEl.createEl("p", {
      text: "현재 엔진: " + (this.plugin.useEdgeTts ? "Edge TTS 서버 (모바일)" : "Web Speech API (데스크탑)"),
      cls: "setting-item-description",
    });

    // Edge TTS 서버 설정 (모바일)
    if (this.plugin.useEdgeTts) {
      new obsidian.Setting(containerEl)
        .setName("TTS 서버 주소")
        .setDesc("Edge TTS 서버 URL (예: http://100.69.168.49:8130)")
        .addText((text) =>
          text
            .setPlaceholder("http://100.69.168.49:8130")
            .setValue(this.plugin.settings.ttsServerUrl)
            .onChange(async (value) => {
              this.plugin.settings.ttsServerUrl = value;
              await this.plugin.saveSettings();
            })
        );

      new obsidian.Setting(containerEl)
        .setName("음성")
        .setDesc("ko-KR-SunHiNeural (여성) / ko-KR-InJoonNeural (남성)")
        .addDropdown((dropdown) => {
          dropdown.addOption("ko-KR-SunHiNeural", "한국어 여성 (SunHi)");
          dropdown.addOption("ko-KR-InJoonNeural", "한국어 남성 (InJoon)");
          dropdown.addOption("en-US-JennyNeural", "영어 여성 (Jenny)");
          dropdown.addOption("en-US-GuyNeural", "영어 남성 (Guy)");
          dropdown.setValue(this.plugin.settings.edgeTtsVoice);
          dropdown.onChange(async (value) => {
            this.plugin.settings.edgeTtsVoice = value;
            await this.plugin.saveSettings();
          });
        });
    }

    // 속도
    new obsidian.Setting(containerEl)
      .setName("읽기 속도")
      .setDesc("0.25 ~ 4.0 (기본: 1.0)")
      .addSlider((slider) =>
        slider
          .setLimits(0.25, 4.0, 0.25)
          .setValue(this.plugin.settings.rate)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.rate = value;
            await this.plugin.saveSettings();
          })
      );

    // 피치 (Web Speech만)
    if (!this.plugin.useEdgeTts) {
      new obsidian.Setting(containerEl)
        .setName("음높이 (pitch)")
        .setDesc("0.5 ~ 2.0 (기본: 1.0)")
        .addSlider((slider) =>
          slider
            .setLimits(0.5, 2.0, 0.1)
            .setValue(this.plugin.settings.pitch)
            .setDynamicTooltip()
            .onChange(async (value) => {
              this.plugin.settings.pitch = value;
              await this.plugin.saveSettings();
            })
        );

      // 음성 선택 (Web Speech만)
      const voiceSetting = new obsidian.Setting(containerEl)
        .setName("음성 선택")
        .setDesc("시스템에서 사용 가능한 음성 목록");

      const loadVoices = () => {
        try {
          const voices = window.speechSynthesis.getVoices();
          if (voices.length === 0) return;
          voiceSetting.addDropdown((dropdown) => {
            dropdown.addOption("", "시스템 기본값");
            const koVoices = voices.filter((v) => v.lang.startsWith("ko"));
            const enVoices = voices.filter((v) => v.lang.startsWith("en"));
            if (koVoices.length > 0) koVoices.forEach((v) => dropdown.addOption(v.name, "[한] " + v.name));
            if (enVoices.length > 0) enVoices.forEach((v) => dropdown.addOption(v.name, "[영] " + v.name));
            dropdown.setValue(this.plugin.settings.voiceName);
            dropdown.onChange(async (value) => {
              this.plugin.settings.voiceName = value;
              await this.plugin.saveSettings();
            });
          });
        } catch (e) {}
      };

      try {
        if (window.speechSynthesis.getVoices().length > 0) loadVoices();
        else {
          window.speechSynthesis.onvoiceschanged = () => loadVoices();
          setTimeout(() => loadVoices(), 1000);
        }
      } catch (e) {}
    }

    // 테스트 버튼
    new obsidian.Setting(containerEl)
      .setName("음성 테스트")
      .setDesc("현재 설정으로 테스트 문장을 읽어봅니다")
      .addButton((button) =>
        button.setButtonText("테스트").onClick(() => {
          this.plugin.engine.speak(
            "안녕하세요. TTS 리더 테스트입니다.",
            () => new obsidian.Notice("테스트 완료"),
            (err) => new obsidian.Notice("테스트 실패: " + err, 5000)
          );
        })
      );

    // 진단 버튼
    new obsidian.Setting(containerEl)
      .setName("진단")
      .setDesc("TTS 문제를 확인합니다")
      .addButton((button) =>
        button.setButtonText("진단 실행").onClick(() => this.plugin.diagnose())
      );
  }
}

module.exports = TtsReaderPlugin;
