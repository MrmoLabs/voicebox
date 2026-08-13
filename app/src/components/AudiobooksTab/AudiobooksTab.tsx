import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Loader2,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Scissors,
  Square,
  Trash2,
  Volume2,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/use-toast';
import { apiClient } from '@/lib/api/client';
import type { AudiobookSentence, GenerationRequest, VoiceProfileResponse } from '@/lib/api/types';
import {
  ALL_LANGUAGES,
  getLanguageOptionsForEngine,
  type LanguageCode,
} from '@/lib/constants/languages';
import { cn } from '@/lib/utils/cn';

const ENGINES = [
  ['qwen:1.7B', 'Qwen3-TTS 1.7B'],
  ['qwen:0.6B', 'Qwen3-TTS 0.6B'],
  ['qwen_custom_voice:1.7B', 'Qwen CustomVoice 1.7B'],
  ['qwen_custom_voice:0.6B', 'Qwen CustomVoice 0.6B'],
  ['luxtts', 'LuxTTS'],
  ['chatterbox', 'Chatterbox'],
  ['chatterbox_turbo', 'Chatterbox Turbo'],
  ['tada:1B', 'TADA 1B'],
  ['tada:3B', 'TADA 3B Multilingual'],
  ['kokoro', 'Kokoro 82M'],
] as const;

function engineParts(value: string) {
  const [engine, modelSize] = value.split(':');
  return { engine: engine as GenerationRequest['engine'], modelSize };
}

function profileSupports(profile: VoiceProfileResponse, engine: string) {
  const type = profile.voice_type || 'cloned';
  if (type === 'preset') return profile.preset_engine === engine;
  if (type === 'cloned')
    return ['qwen', 'luxtts', 'chatterbox', 'chatterbox_turbo', 'tada'].includes(engine);
  return true;
}

export function AudiobooksTab() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [bookId, setBookId] = useState<string | null>(null);
  const [chapterId, setChapterId] = useState<string | null>(null);
  const [newBookOpen, setNewBookOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newAuthor, setNewAuthor] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [profileId, setProfileId] = useState<string>('');
  const [engineValue, setEngineValue] = useState('qwen:1.7B');
  const [language, setLanguage] = useState<LanguageCode>('zh');
  const [instruct, setInstruct] = useState('');
  const [generating, setGenerating] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [playingIndex, setPlayingIndex] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [rate, setRate] = useState('1');
  const audioRef = useRef<HTMLAudioElement>(null);
  const stopRequestedRef = useRef(false);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  const booksQuery = useQuery({
    queryKey: ['audiobooks'],
    queryFn: () => apiClient.listAudiobooks(),
  });
  const bookQuery = useQuery({
    queryKey: ['audiobook', bookId],
    queryFn: () => apiClient.getAudiobook(bookId!),
    enabled: !!bookId,
    // Keep sentence task states fresh even after all requests have been queued.
    refetchInterval: 1500,
  });
  const profilesQuery = useQuery({
    queryKey: ['profiles'],
    queryFn: () => apiClient.listProfiles(),
  });

  const book = bookQuery.data;
  const chapter = book?.chapters.find((c) => c.id === chapterId) ?? book?.chapters[0];
  const sentences = chapter?.sentences ?? [];
  const currentSentence = playingIndex === null ? undefined : sentences[playingIndex];
  const currentSentenceId = currentSentence?.id;
  const currentGenerationId = currentSentence?.generation_id;
  const currentGenerationStatus = currentSentence?.generation_status;
  const { engine, modelSize } = engineParts(engineValue);
  const compatibleProfiles = useMemo(
    () => (profilesQuery.data ?? []).filter((p) => profileSupports(p, engine || 'qwen')),
    [profilesQuery.data, engine],
  );
  const completedCount = sentences.filter((s) => s.generation_status === 'completed').length;
  const failedCount = sentences.filter((s) => s.generation_status === 'failed').length;
  const activeCount = sentences.filter((s) =>
    ['generating', 'loading_model'].includes(s.generation_status || ''),
  ).length;
  const bookActiveCount = (book?.chapters ?? []).reduce(
    (total, item) =>
      total + item.sentences.filter((sentence) =>
        ['generating', 'loading_model'].includes(sentence.generation_status || ''),
      ).length,
    0,
  );
  const pendingCount = sentences.filter((s) => !s.generation_id).length;
  const processedCount = completedCount + failedCount;
  const progressPercent = sentences.length ? (processedCount / sentences.length) * 100 : 0;
  const processingIndex = sentences.findIndex((s) =>
    ['generating', 'loading_model'].includes(s.generation_status || ''),
  );

  useEffect(() => {
    if (!bookId && booksQuery.data?.length) setBookId(booksQuery.data[0].id);
  }, [bookId, booksQuery.data]);
  useEffect(() => {
    if (book?.chapters.length && !book.chapters.some((c) => c.id === chapterId))
      setChapterId(book.chapters[0].id);
  }, [book, chapterId]);
  useEffect(() => {
    if (chapter) setSourceText(chapter.source_text);
  }, [chapter]);
  useEffect(() => {
    if (!compatibleProfiles.some((p) => p.id === profileId))
      setProfileId(compatibleProfiles[0]?.id ?? '');
  }, [compatibleProfiles, profileId]);
  useEffect(() => {
    const available = getLanguageOptionsForEngine(engine || 'qwen');
    if (!available.some((item) => item.value === language))
      setLanguage(available[0]?.value ?? 'en');
  }, [engine, language]);
  useEffect(() => {
    if (playingIndex === null) return;
    if (!currentGenerationId || currentGenerationStatus !== 'completed') {
      setIsPlaying(false);
      return;
    }
    const audio = audioRef.current;
    if (!audio) return;
    audio.src = apiClient.getAudioUrl(currentGenerationId);
    audio
      .play()
      .then(() => setIsPlaying(true))
      .catch(() => setIsPlaying(false));
    if (currentSentenceId)
      rowRefs.current
        .get(currentSentenceId)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [playingIndex, currentSentenceId, currentGenerationId, currentGenerationStatus]);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['audiobooks'] }),
      queryClient.invalidateQueries({ queryKey: ['audiobook', bookId] }),
    ]);
  };

  const createBook = useMutation({
    mutationFn: async () => {
      const created = await apiClient.createAudiobook({
        title: newTitle.trim(),
        author: newAuthor.trim() || undefined,
      });
      const firstChapter = await apiClient.createAudiobookChapter(created.id, {
        title: '第一章',
        source_text: '',
      });
      return { created, firstChapter };
    },
    onSuccess: async ({ created, firstChapter }) => {
      setBookId(created.id);
      setChapterId(firstChapter.id);
      setNewBookOpen(false);
      setNewTitle('');
      setNewAuthor('');
      await refresh();
    },
  });

  const splitChapter = async () => {
    if (!chapter || !sourceText.trim()) return;
    if (
      sentences.some((s) => s.generation_id) &&
      !window.confirm('重新切分会移除本章现有的逐句语音绑定，是否继续？')
    )
      return;
    try {
      const result = await apiClient.splitAudiobookChapter(chapter.id, sourceText);
      queryClient.setQueryData(
        ['audiobook', bookId],
        book
          ? { ...book, chapters: book.chapters.map((c) => (c.id === result.id ? result : c)) }
          : book,
      );
      await refresh();
    } catch (error) {
      toast({ title: '切分失败', description: String(error), variant: 'destructive' });
    }
  };

  const addChapter = async () => {
    if (!book) return;
    const title = window.prompt('章节名称', `第 ${book.chapters.length + 1} 章`)?.trim();
    if (!title) return;
    const created = await apiClient.createAudiobookChapter(book.id, { title, source_text: '' });
    setChapterId(created.id);
    await refresh();
  };

  const generationData = (text: string): GenerationRequest => ({
    profile_id: profileId,
    text,
    language,
    engine,
    model_size: modelSize as GenerationRequest['model_size'],
    instruct: engine === 'qwen_custom_voice' ? instruct || undefined : undefined,
    source: 'audiobook',
  });

  const generateSentence = async (sentence: AudiobookSentence, forceNew = false) => {
    if (!profileId) throw new Error('请先选择声音');
    const result =
      !forceNew && sentence.generation_status === 'failed' && sentence.generation_id
        ? await apiClient.retryGeneration(sentence.generation_id)
        : await apiClient.generateSpeech(generationData(sentence.text));
    if (result.id !== sentence.generation_id)
      await apiClient.updateAudiobookSentence(sentence.id, { generation_id: result.id });
    await refresh();
    return result;
  };

  const waitForGeneration = async (generationId: string) => {
    // /generate acknowledges an asynchronous job. Do not submit the next
    // audiobook sentence until this one reaches a terminal state, otherwise a
    // long chapter can flood the model worker with hundreds of jobs.
    const deadline = Date.now() + 30 * 60 * 1000;
    while (Date.now() < deadline) {
      if (stopRequestedRef.current) return 'stopped' as const;
      const generation = await apiClient.getGeneration(generationId);
      await queryClient.invalidateQueries({ queryKey: ['audiobook', bookId] });
      if (generation.status === 'completed') return 'completed' as const;
      if (generation.status === 'failed') return 'failed' as const;
      await new Promise((resolve) => window.setTimeout(resolve, 1200));
    }
    throw new Error('单句生成超过 30 分钟，队列已暂停');
  };

  const regenerateSentence = async (sentence: AudiobookSentence) => {
    try {
      const generation = await generateSentence(sentence, true);
      await waitForGeneration(generation.id);
      await refresh();
    } catch (error) {
      toast({ title: '重新生成失败', description: String(error), variant: 'destructive' });
    }
  };

  const addSentence = async (position: number) => {
    if (!chapter) return;
    const text = window.prompt('请输入新句子')?.trim();
    if (!text) return;
    try {
      await apiClient.createAudiobookSentence(chapter.id, { text, position });
      await refresh();
    } catch (error) {
      toast({ title: '新增句子失败', description: String(error), variant: 'destructive' });
    }
  };

  const editSentence = async (sentence: AudiobookSentence) => {
    const text = window.prompt('编辑句子（修改后原语音将解除绑定）', sentence.text)?.trim();
    if (!text || text === sentence.text) return;
    try {
      await apiClient.updateAudiobookSentence(sentence.id, { text });
      await refresh();
    } catch (error) {
      toast({ title: '修改句子失败', description: String(error), variant: 'destructive' });
    }
  };

  const deleteSentence = async (sentence: AudiobookSentence) => {
    if (!window.confirm(`确定删除第 ${sentence.position + 1} 句吗？`)) return;
    try {
      if (sentence.id === currentSentenceId) {
        audioRef.current?.pause();
        setPlayingIndex(null);
        setIsPlaying(false);
      }
      await apiClient.deleteAudiobookSentence(sentence.id);
      await refresh();
    } catch (error) {
      toast({ title: '删除句子失败', description: String(error), variant: 'destructive' });
    }
  };

  const generateAll = async (onlyFailed = false) => {
    if (!profileId || !sentences.length) return;
    setGenerating(true);
    stopRequestedRef.current = false;
    const targets = sentences.filter((s) =>
      onlyFailed
        ? s.generation_status === 'failed'
        : !s.generation_id || s.generation_status === 'failed',
    );
    for (const sentence of targets) {
      if (stopRequestedRef.current) break;
      try {
        const generation = await generateSentence(sentence);
        if (stopRequestedRef.current) {
          await apiClient.cancelGeneration(generation.id).catch(() => undefined);
          break;
        }
        const terminalStatus = await waitForGeneration(generation.id);
        if (terminalStatus === 'stopped') break;
      } catch (error) {
        toast({
          title: `第 ${sentence.position + 1} 句提交失败`,
          description: String(error),
          variant: 'destructive',
        });
      }
    }
    setGenerating(false);
    await refresh();
  };

  const stopGeneration = async () => {
    if (!bookId) return;
    stopRequestedRef.current = true;
    setStopping(true);
    try {
      const result = await apiClient.cancelAudiobookGeneration(bookId);
      toast({
        title: '已中止整本书的生成安排',
        description: result.cancelled
          ? `已中止 ${result.cancelled} 个活动或排队任务，后续句子不会再提交。`
          : '没有发现仍在活动的任务，后续句子不会再提交。',
      });
    } finally {
      setGenerating(false);
      setStopping(false);
      await refresh();
    }
  };

  const playFrom = (index: number) => {
    if (playingIndex === index && isPlaying) {
      audioRef.current?.pause();
      setIsPlaying(false);
      return;
    }
    if (playingIndex === index && audioRef.current) {
      audioRef.current
        .play()
        .then(() => setIsPlaying(true))
        .catch(() => setIsPlaying(false));
      return;
    }
    setPlayingIndex(index);
  };
  const playAdjacent = (delta: number) => {
    if (playingIndex === null) return;
    const next = playingIndex + delta;
    if (next >= 0 && next < sentences.length) setPlayingIndex(next);
  };
  const onEnded = () => {
    if (playingIndex === null) return;
    const next = sentences.findIndex(
      (s, i) => i > playingIndex && s.generation_status === 'completed' && !!s.generation_id,
    );
    if (next >= 0) setPlayingIndex(next);
    else setIsPlaying(false);
  };

  return (
    <div className="h-full min-h-0 grid grid-cols-[240px_minmax(420px,1fr)_300px] gap-5 py-6 pb-24">
      <aside className="min-h-0 flex flex-col border-r pr-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold">有声图书</h2>
          <Button size="icon" variant="outline" onClick={() => setNewBookOpen(true)}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        <div className="space-y-2 overflow-y-auto">
          {(booksQuery.data ?? []).map((item) => (
            <button
              type="button"
              key={item.id}
              onClick={() => setBookId(item.id)}
              className={cn(
                'w-full text-left rounded-lg border p-3 hover:bg-muted/50',
                item.id === bookId && 'border-primary bg-primary/5',
              )}
            >
              <div className="font-medium truncate">{item.title}</div>
              <div className="text-xs text-muted-foreground mt-1">
                {item.chapter_count} 章 · {item.sentence_count} 句
              </div>
            </button>
          ))}
          {!booksQuery.isLoading && !booksQuery.data?.length && (
            <div className="text-center text-sm text-muted-foreground py-12">
              <BookOpen className="h-9 w-9 mx-auto mb-3" />
              创建第一本有声图书
            </div>
          )}
        </div>
      </aside>

      <main className="min-h-0 flex flex-col">
        {!book || !chapter ? (
          <div className="h-full flex items-center justify-center text-muted-foreground">
            请新建或选择一本图书
          </div>
        ) : (
          <>
            <div className="shrink-0 mb-4">
              <div className="flex items-center gap-3">
                <h1 className="text-2xl font-bold">{book.title}</h1>
                <span className="text-sm text-muted-foreground">{book.author}</span>
              </div>
              <div className="flex gap-2 mt-3">
                {book.chapters.map((c) => (
                  <Button
                    key={c.id}
                    size="sm"
                    variant={c.id === chapter.id ? 'default' : 'outline'}
                    onClick={() => setChapterId(c.id)}
                  >
                    {c.title}
                  </Button>
                ))}
                <Button size="sm" variant="ghost" onClick={addChapter}>
                  <Plus className="h-4 w-4 mr-1" />
                  新增章节
                </Button>
              </div>
            </div>
            {!sentences.length ? (
              <div className="flex-1 min-h-0 flex flex-col">
                <div className="flex justify-between mb-2">
                  <Label>粘贴章节正文</Label>
                  <span className="text-xs text-muted-foreground">
                    {sourceText.length.toLocaleString()} 字
                  </span>
                </div>
                <Textarea
                  value={sourceText}
                  onChange={(e) => setSourceText(e.target.value)}
                  placeholder="在这里粘贴大段文字。段落和中文、英文句末标点会被自动识别……"
                  className="flex-1 resize-none text-base leading-8"
                />
                <Button className="mt-4" disabled={!sourceText.trim()} onClick={splitChapter}>
                  <Scissors className="h-4 w-4 mr-2" />
                  分析并切分
                </Button>
              </div>
            ) : (
              <div className="flex-1 min-h-0 flex flex-col">
                <div className="shrink-0 rounded-xl border bg-card p-4 mb-3 space-y-3">
                  <div className="flex items-center justify-between gap-4 text-sm">
                    <div className="font-medium">
                      {processingIndex >= 0
                        ? `正在处理第 ${processingIndex + 1} 句`
                        : generating
                          ? '正在准备下一条任务'
                          : activeCount > 0
                            ? '正在同步任务状态'
                            : processedCount === sentences.length
                              ? '本章处理完成'
                              : '等待开始生成'}
                    </div>
                    <div className="text-muted-foreground tabular-nums">
                      已处理 {processedCount} / {sentences.length}
                    </div>
                  </div>
                  <Progress value={progressPercent} className="h-2" />
                  <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
                    <span>未处理 {pendingCount}</span>
                    <span className="text-blue-500">处理中 {activeCount}</span>
                    <span className="text-emerald-500">已完成 {completedCount}</span>
                    <span className={failedCount ? 'text-destructive' : undefined}>
                      失败 {failedCount}
                    </span>
                  </div>
                  <div className="flex justify-end">
                    <Button size="sm" variant="outline" onClick={() => addSentence(sentences.length)}>
                      <Plus className="h-3.5 w-3.5 mr-1" />
                      末尾新增句子
                    </Button>
                  </div>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto pr-2 space-y-1">
                  {sentences.map((sentence, index) => {
                    const active = index === playingIndex;
                    const status = sentence.generation_status;
                    const isProcessing = ['generating', 'loading_model'].includes(status || '');
                    const statusLabel =
                      active && isPlaying
                        ? '正在播放'
                        : status === 'completed'
                          ? '已完成'
                          : status === 'loading_model'
                            ? '正在加载模型'
                            : status === 'generating'
                              ? '正在生成'
                              : status === 'failed'
                                ? '生成失败'
                                : sentence.generation_id
                                  ? '等待状态'
                                  : '未处理';
                    return (
                      <div
                        ref={(el) => {
                          if (el) rowRefs.current.set(sentence.id, el);
                          else rowRefs.current.delete(sentence.id);
                        }}
                        key={sentence.id}
                        onClick={() => status === 'completed' && playFrom(index)}
                        className={cn(
                          'w-full grid grid-cols-[42px_1fr_auto] gap-3 text-left rounded-lg px-3 py-3 border border-transparent transition-colors',
                          status === 'completed' && 'hover:bg-muted/50 cursor-pointer',
                          active && 'bg-primary/10 border-primary/40 shadow-sm',
                        )}
                      >
                        <span className="text-xs text-muted-foreground pt-1 tabular-nums">
                          {String(index + 1).padStart(3, '0')}
                        </span>
                        <span className="min-w-0">
                          <span
                            className={cn('block leading-7', active && 'text-primary font-medium')}
                          >
                            {sentence.text}
                          </span>
                          {status === 'failed' && sentence.generation_error && (
                            <span className="block text-xs text-destructive mt-1 line-clamp-2">
                              {sentence.generation_error}
                            </span>
                          )}
                        </span>
                        <span className="min-w-32 flex justify-end items-center gap-2 text-xs text-muted-foreground">
                          {active && isPlaying ? (
                            <Volume2 className="h-4 w-4 text-primary animate-pulse" />
                          ) : status === 'completed' ? (
                            <Play className="h-4 w-4" />
                          ) : isProcessing ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : status === 'failed' ? (
                            <CircleAlert className="h-4 w-4 text-destructive" />
                          ) : null}
                          <span
                            className={cn(
                              'rounded-full border px-2.5 py-1 whitespace-nowrap font-medium',
                              !sentence.generation_id && 'bg-muted/50',
                              isProcessing && 'border-blue-500/40 bg-blue-500/10 text-blue-500',
                              status === 'completed' &&
                                'border-emerald-500/40 bg-emerald-500/10 text-emerald-500',
                              status === 'failed' &&
                                'border-destructive/40 bg-destructive/10 text-destructive',
                              active && isPlaying && 'border-primary/40 bg-primary/10 text-primary',
                            )}
                          >
                            {statusLabel}
                          </span>
                          {(status === 'completed' || status === 'failed') && (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (status === 'completed') regenerateSentence(sentence);
                                else generateSentence(sentence);
                              }}
                              title={status === 'completed' ? '重新生成这句话' : '重试这句话'}
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            disabled={isProcessing}
                            title="编辑句子"
                            onClick={(e) => {
                              e.stopPropagation();
                              editSentence(sentence);
                            }}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            title="在此句后新增"
                            onClick={(e) => {
                              e.stopPropagation();
                              addSentence(index + 1);
                            }}
                          >
                            <Plus className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-destructive"
                            disabled={isProcessing}
                            title="删除句子"
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteSentence(sentence);
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </main>

      <aside className="min-h-0 overflow-y-auto border-l pl-5 space-y-5">
        <div>
          <h3 className="font-semibold mb-1">生成设置</h3>
          <p className="text-xs text-muted-foreground">每句话将生成一条独立语音</p>
        </div>
        <div className="space-y-2">
          <Label>声音</Label>
          <Select value={profileId} onValueChange={setProfileId}>
            <SelectTrigger>
              <SelectValue placeholder="选择声音" />
            </SelectTrigger>
            <SelectContent>
              {compatibleProfiles.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>引擎与模型</Label>
          <Select value={engineValue} onValueChange={setEngineValue}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ENGINES.map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>语言</Label>
          <Select value={language} onValueChange={(v) => setLanguage(v as LanguageCode)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {getLanguageOptionsForEngine(engine || 'qwen').map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {ALL_LANGUAGES[item.value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {engine === 'qwen_custom_voice' && (
          <div className="space-y-2">
            <Label>演绎指令</Label>
            <Textarea
              value={instruct}
              onChange={(e) => setInstruct(e.target.value)}
              placeholder="例如：温暖、平静地讲述"
              className="min-h-20"
            />
          </div>
        )}
        {!!sentences.length && (
          <div className="rounded-lg bg-muted/40 p-3 text-sm space-y-1">
            <div className="flex justify-between">
              <span>总计</span>
              <span>{sentences.length} 句</span>
            </div>
            <div className="flex justify-between text-emerald-500">
              <span>已完成</span>
              <span>{completedCount}</span>
            </div>
            <div className="flex justify-between">
              <span>生成中</span>
              <span>{activeCount}</span>
            </div>
            {failedCount > 0 && (
              <div className="flex justify-between text-destructive">
                <span>失败</span>
                <span>{failedCount}</span>
              </div>
            )}
          </div>
        )}
        <Button
          className="w-full"
          disabled={!sentences.length || !profileId || generating}
          onClick={() => generateAll(false)}
        >
          {generating ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Volume2 className="h-4 w-4 mr-2" />
          )}
          生成全部待处理句子
        </Button>
        {(generating || bookActiveCount > 0) && (
          <Button
            variant="destructive"
            className="w-full"
            disabled={stopping}
            onClick={stopGeneration}
          >
            {stopping ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Square className="h-4 w-4 mr-2" />
            )}
            {stopping
              ? '正在中止整本书…'
              : `中止整本书生成${bookActiveCount ? `（${bookActiveCount}）` : ''}`}
          </Button>
        )}
        {failedCount > 0 && (
          <Button
            variant="outline"
            className="w-full"
            disabled={generating}
            onClick={() => generateAll(true)}
          >
            <RotateCcw className="h-4 w-4 mr-2" />
            仅重试失败项
          </Button>
        )}
        {book && (
          <Button
            variant="ghost"
            className="w-full text-destructive"
            onClick={async () => {
              if (window.confirm(`删除《${book.title}》？语音历史不会被删除。`)) {
                await apiClient.deleteAudiobook(book.id);
                setBookId(null);
                await refresh();
              }
            }}
          >
            <Trash2 className="h-4 w-4 mr-2" />
            删除图书
          </Button>
        )}
      </aside>

      {playingIndex !== null && (
        <div className="fixed bottom-5 left-28 right-8 h-16 rounded-2xl border bg-card/95 backdrop-blur shadow-xl z-40 flex items-center gap-4 px-5">
          <Button size="icon" variant="ghost" onClick={() => playAdjacent(-1)}>
            <ChevronLeft />
          </Button>
          <Button size="icon" onClick={() => playFrom(playingIndex)}>
            {isPlaying ? <Pause /> : <Play />}
          </Button>
          <Button size="icon" variant="ghost" onClick={() => playAdjacent(1)}>
            <ChevronRight />
          </Button>
          <div className="min-w-0 flex-1">
            <div className="text-sm truncate">{sentences[playingIndex]?.text}</div>
            <div className="text-xs text-muted-foreground mt-1">
              第 {playingIndex + 1} / {sentences.length} 句
            </div>
          </div>
          <Select
            value={rate}
            onValueChange={(v) => {
              setRate(v);
              if (audioRef.current) audioRef.current.playbackRate = Number(v);
            }}
          >
            <SelectTrigger className="w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {['0.75', '1', '1.25', '1.5', '2'].map((v) => (
                <SelectItem key={v} value={v}>
                  {v}×
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {/* biome-ignore lint/a11y/useMediaCaption: the synchronized spoken text is visible and highlighted above. */}
      <audio
        ref={audioRef}
        onEnded={onEnded}
        onPause={() => setIsPlaying(false)}
        onPlay={() => setIsPlaying(true)}
      />

      <Dialog open={newBookOpen} onOpenChange={setNewBookOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建有声图书</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>书名</Label>
              <Input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} autoFocus />
            </div>
            <div className="space-y-2">
              <Label>作者（选填）</Label>
              <Input value={newAuthor} onChange={(e) => setNewAuthor(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewBookOpen(false)}>
              取消
            </Button>
            <Button
              disabled={!newTitle.trim() || createBook.isPending}
              onClick={() => createBook.mutate()}
            >
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
