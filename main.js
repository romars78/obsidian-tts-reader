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
};

// ─── Google Translate TTS 엔진 (모바일용) ───
// Obsidian requestUrl로 오디오 데이터를 직접 다운로드 → Blob → Audio 재생
class GoogleTtsEngine {
  constructor(settings) {
    this.settings = settings;
    this.audio = null;
    this.blobUrl = null;
    this.chunks = [];
    this.currentIndex = 0;
    this.isPlaying = false;
    this.isPaused = false;
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
    this.chunks = this.splitText(text, 180);
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
    const lang = this.settings.lang || "ko";
    const encoded = encodeURIComponent(chunk);
    const url = "https://translate.google.com/translate_tts?ie=UTF-8&tl=" + lang + "&client=tw-ob&q=" + encoded;

    try {
      // Obsidian requestUrl: CORS 우회, 네이티브 HTTP 요청
      const response = await obsidian.requestUrl({
        url: url,
        method: "GET",
      });

      // ArrayBuffer → Blob → Object URL
      const blob = new Blob([response.arrayBuffer], { type: "audio/mpeg" });

      // 이전 blob URL 해제
      if (this.blobUrl) {
        URL.revokeObjectURL(this.blobUrl);
      }
      this.blobUrl = URL.createObjectURL(blob);

      this.audio = new Audio(this.blobUrl);
      this.audio.playbackRate = this.settings.rate || 1.0;

      this.audio.onended = () => {
        this.currentIndex++;
        if (this.isPlaying && !this.isPaused) {
          this.playNext();
        }
      };

      this.audio.onerror = (e) => {
        console.error("TTS audio playback error:", e);
        this.currentIndex++;
        if (this.isPlaying) this.playNext();
      };

      await this.audio.play();

    } catch (e) {
      console.error("TTS fetch/play error:", e);
      // 이 청크 건너뛰고 다음 시도
      this.currentIndex++;
      if (this.isPlaying) {
        this.playNext();
      }
    }
  }

  pause() {
    if (this.audio && this.isPlaying) {
      this.audio.pause();
      this.isPaused = true;
    }
  }

  resume() {
    if (this.audio && this.isPaused) {
      this.audio.play();
      this.isPaused = false;
    }
  }

  stop() {
    this.isPlaying = false;
    this.isPaused = false;
    if (this.audio) {
      this.audio.pause();
      this.audio.src = "";
      this.audio = null;
    }
    if (this.blobUrl) {
      URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = null;
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
    this.useGoogleTts = false;
  }

  async onload() {
    await this.loadSettings();

    // 엔진 선택: speechSynthesis 있으면 WebSpeech, 없으면 Google TTS
    if (typeof window !== "undefined" && window.speechSynthesis) {
      this.engine = new WebSpeechEngine(this.settings);
      this.useGoogleTts = false;
    } else {
      this.engine = new GoogleTtsEngine(this.settings);
      this.useGoogleTts = true;
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
    console.log("TTS Reader loaded (engine: " + (this.useGoogleTts ? "Google TTS" : "Web Speech") + ")");
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
    lines.push("엔진: " + (this.useGoogleTts ? "Google TTS" : "Web Speech"));
    lines.push("Audio 지원: " + (typeof Audio !== "undefined" ? "있음" : "없음"));

    if (!this.useGoogleTts && window.speechSynthesis) {
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

    const engineName = this.useGoogleTts ? "Google TTS" : "Web Speech";
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
      text: "현재 엔진: " + (this.plugin.useGoogleTts ? "Google TTS (모바일)" : "Web Speech API (데스크탑)"),
      cls: "setting-item-description",
    });

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
    if (!this.plugin.useGoogleTts) {
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
