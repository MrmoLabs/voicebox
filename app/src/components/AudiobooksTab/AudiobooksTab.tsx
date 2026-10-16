import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  BookOpen,
  ChevronsDown,
  ChevronsUp,
  Check,
  CircleAlert,
  GripVertical,
  Loader2,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Scissors,
  Settings2,
  Square,
  Trash2,
  Volume2,
  X,
} from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { AudiobookPlayer } from './AudiobookPlayer';
import { GenerationProgress } from '@/components/Generation/GenerationProgress';
import { ModelRuntimeControl, engineModelName } from '@/components/Generation/ModelRuntimeControl';
import { isProfileCompatibleWithEngine } from '@/lib/constants/voiceCompatibility';
import './AudiobooksTab.css';
import { ToastAction } from '@/components/ui/toast';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import type {
  AudiobookDetail,
  AudiobookSentence,
  GenerationRequest,
  VoiceProfileResponse,
} from '@/lib/api/types';
import {
  ALL_LANGUAGES,
  getLanguageOptionsForEngine,
  type LanguageCode,
} from '@/lib/constants/languages';
import { cn } from '@/lib/utils/cn';
import { usePlatform } from '@/platform/PlatformContext';
import { usePlayerStore } from '@/stores/playerStore';
import { useUIStore } from '@/stores/uiStore';
import { livePlayback } from '@/lib/audio/livePlayback';

const ENGINES = [
  ['qwen:1.7B', 'Qwen3-TTS 1.7B'],
  ['qwen:0.6B', 'Qwen3-TTS 0.6B'],
  ['qwen_custom_voice:1.7B', 'Qwen CustomVoice 1.7B'],
  ['qwen_custom_voice:0.6B', 'Qwen CustomVoice 0.6B'],
  ['qwen_voice_design', 'Qwen VoiceDesign 1.7B'],
  ['luxtts', 'LuxTTS'],
  ['chatterbox', 'Chatterbox'],
  ['chatterbox_turbo', 'Chatterbox Turbo'],
  ['tada:1B', 'TADA 1B'],
  ['tada:3B', 'TADA 3B Multilingual'],
  ['kokoro', 'Kokoro 82M'],
  ['omnivoice', 'OmniVoice'],
] as const;

function engineParts(value: string) {
  const [engine, modelSize] = value.split(':');
  return { engine: engine as GenerationRequest['engine'], modelSize };
}

function profileSupports(profile: VoiceProfileResponse, engine: string) {
  return isProfileCompatibleWithEngine(profile, engine);
}

function SortableSentenceRow({
  id,
  disabled,
  className,
  onClick,
  rowRef,
  children,
}: {
  id: string;
  disabled: boolean;
  className: string;
  onClick: () => void;
  rowRef: (element: HTMLDivElement | null) => void;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled,
  });
  return (
    <div
      ref={(element) => {
        setNodeRef(element);
        rowRef(element);
      }}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        contentVisibility: 'auto',
        containIntrinsicSize: '112px',
      }}
      onClick={onClick}
      className={cn(className, isDragging && 'relative z-20 opacity-70 shadow-lg bg-card')}
    >
      <button
        type="button"
        className="mt-0.5 h-6 w-6 cursor-grab touch-none text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
        disabled={disabled}
        title="拖动调整句子顺序"
        onClick={(event) => event.stopPropagation()}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-4 w-4" />
      </button>
      {children}
    </div>
  );
}

function formatDuration(duration?: number) {
  if (duration === undefined || duration === null) return '—';
  const minutes = Math.floor(duration / 60);
  const seconds = Math.round(duration % 60);
  return minutes ? `${minutes}:${String(seconds).padStart(2, '0')}` : `${seconds} 秒`;
}

export function AudiobooksTab() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const platform = usePlatform();
  const [bookId, setBookId] = useState<string | null>(null);
  const [chapterId, setChapterId] = useState<string | null>(null);
  const [newBookOpen, setNewBookOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const pageRef = useRef<HTMLDivElement>(null);
  const [recycleBinOpen, setRecycleBinOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newAuthor, setNewAuthor] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [profileId, setProfileId] = useState<string>(
    () => useUIStore.getState().selectedProfileId || '',
  );
  const [engineValue, setEngineValue] = useState(() => {
    const selected = useUIStore.getState().selectedEngine || 'qwen';
    if (selected === 'qwen' || selected === 'qwen_custom_voice') return `${selected}:1.7B`;
    if (selected === 'tada') return 'tada:1B';
    return selected;
  });
  const [language, setLanguage] = useState<LanguageCode>('zh');
  const [instruct, setInstruct] = useState('');
  const [generating, setGenerating] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [playingSentenceId, setPlayingSentenceId] = useState<string | null>(null);
  const [playingGenerationId, setPlayingGenerationId] = useState<string | null>(null);
  const [playbackIntent, setPlaybackIntent] = useState<'stopped' | 'paused' | 'playing'>('stopped');
  const [deleteRequest, setDeleteRequest] = useState<
    | { type: 'single'; sentence: AudiobookSentence }
    | { type: 'selected'; sentences: AudiobookSentence[] }
    | null
  >(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [rate, setRate] = useState('1');
  const [selectedSentenceIds, setSelectedSentenceIds] = useState<Set<string>>(new Set());
  const [editingSentenceIds, setEditingSentenceIds] = useState<Set<string>>(new Set());
  const [sentenceDrafts, setSentenceDrafts] = useState<Record<string, string>>({});
  const [sentenceFilter, setSentenceFilter] = useState('all');
  const [performanceMode, setPerformanceMode] = useState<'stable' | 'fast'>('stable');
  const [exportPauseMs, setExportPauseMs] = useState('300');
  const [exporting, setExporting] = useState(false);
  const [jumpPosition, setJumpPosition] = useState('');
  const audioRef = useRef<HTMLAudioElement>(null);
  const stopRequestedRef = useRef(false);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const sentenceListRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // This editor owns its sentence player. End previous-page previews so
    // they neither overlap speech nor cover the bottom of the editor.
    livePlayback.stop(false);
    usePlayerStore.getState().reset();
  }, []);
  const dragSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const booksQuery = useQuery({
    queryKey: ['audiobooks'],
    queryFn: () => apiClient.listAudiobooks(),
  });
  const bookQuery = useQuery({
    queryKey: ['audiobook', bookId],
    queryFn: () => apiClient.getAudiobook(bookId!),
    enabled: !!bookId,
  });
  const profilesQuery = useQuery({
    queryKey: ['profiles'],
    queryFn: () => apiClient.listProfiles(),
  });
  const deletedSentencesQuery = useQuery({
    queryKey: ['audiobook-deleted-sentences', chapterId],
    queryFn: () => apiClient.listDeletedAudiobookSentences(chapterId!),
    enabled: !!chapterId,
  });
  const activePlanQuery = useQuery({
    queryKey: ['audiobook-generation-plan', bookId],
    queryFn: () => apiClient.getActiveAudiobookGenerationPlan(bookId!),
    enabled: !!bookId,
    refetchInterval: 1500,
  });
  const sentenceStatusesQuery = useQuery({
    queryKey: ['audiobook-sentence-statuses', chapterId],
    queryFn: () => apiClient.getAudiobookSentenceStatuses(chapterId!),
    enabled: !!chapterId,
    refetchInterval: 1200,
  });

  const book = bookQuery.data;
  const chapter = book?.chapters.find((c) => c.id === chapterId) ?? book?.chapters[0];
  const sentences = chapter?.sentences ?? [];
  const playingIndex = playingSentenceId
    ? sentences.findIndex((sentence) => sentence.id === playingSentenceId)
    : -1;
  const currentSentence = playingIndex >= 0 ? sentences[playingIndex] : undefined;
  const currentSentenceId = currentSentence?.id;
  const currentGenerationId = playingGenerationId || currentSentence?.generation_id;
  const currentGenerationStatus = playingGenerationId
    ? currentSentence?.audio_takes?.find((take) => take.generation_id === playingGenerationId)
        ?.status
    : currentSentence?.generation_status;
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
      total +
      item.sentences.filter((sentence) =>
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
  const visibleSentences = sentences.filter((sentence) => {
    const status = sentence.generation_status;
    if (sentenceFilter === 'pending') return !sentence.generation_id;
    if (sentenceFilter === 'processing')
      return ['generating', 'loading_model'].includes(status || '');
    if (sentenceFilter === 'completed') return status === 'completed';
    if (sentenceFilter === 'failed') return status === 'failed';
    if (sentenceFilter === 'modified')
      return (
        editingSentenceIds.has(sentence.id) &&
        (sentenceDrafts[sentence.id] ?? sentence.text) !== sentence.text
      );
    return true;
  });

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
    setSelectedSentenceIds(new Set());
    setEditingSentenceIds(new Set());
    setSentenceDrafts({});
  }, [chapter?.id]);
  useEffect(() => {
    if (!compatibleProfiles.some((p) => p.id === profileId))
      setProfileId(compatibleProfiles[0]?.id ?? '');
  }, [compatibleProfiles, profileId]);
  useEffect(() => {
    setGenerating(!!activePlanQuery.data);
  }, [activePlanQuery.data]);
  useEffect(() => {
    if (!bookId || !chapterId || !sentenceStatusesQuery.data) return;
    const statuses = new Map(sentenceStatusesQuery.data.map((status) => [status.id, status]));
    queryClient.setQueryData<AudiobookDetail>(['audiobook', bookId], (current) =>
      current
        ? {
            ...current,
            chapters: current.chapters.map((item) =>
              item.id === chapterId
                ? {
                    ...item,
                    sentences: item.sentences.map((sentence) => ({
                      ...sentence,
                      ...statuses.get(sentence.id),
                    })),
                  }
                : item,
            ),
          }
        : current,
    );
  }, [bookId, chapterId, queryClient, sentenceStatusesQuery.data]);
  useEffect(() => {
    const available = getLanguageOptionsForEngine(engine || 'qwen');
    if (!available.some((item) => item.value === language))
      setLanguage(available[0]?.value ?? 'en');
  }, [engine, language]);
  useEffect(() => {
    if (!playingSentenceId || playbackIntent !== 'playing') return;
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
  }, [
    playingSentenceId,
    playbackIntent,
    currentSentenceId,
    currentGenerationId,
    currentGenerationStatus,
  ]);

  useEffect(() => {
    if (playingSentenceId && playingIndex < 0) {
      audioRef.current?.pause();
      setPlayingSentenceId(null);
      setPlaybackIntent('stopped');
      setIsPlaying(false);
    }
  }, [playingSentenceId, playingIndex]);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['audiobooks'] }),
      queryClient.invalidateQueries({ queryKey: ['audiobook', bookId] }),
      queryClient.invalidateQueries({ queryKey: ['audiobook-deleted-sentences', chapterId] }),
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

  const generateSentence = async (sentence: AudiobookSentence) => {
    if (!profileId) throw new Error('请先选择声音');
    // Audiobook retries must use the voice and model currently selected in
    // this page. Retrying the old Generation would also reuse its profile_id,
    // which may reference a voice that has since been deleted.
    const result = await apiClient.generateSpeech(generationData(sentence.text));
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
    stopAudiobookPlayback();
    try {
      const generation = await generateSentence(sentence);
      await waitForGeneration(generation.id);
      await refresh();
    } catch (error) {
      toast({ title: '重新生成失败', description: String(error), variant: 'destructive' });
    }
  };

  const playAudioTake = (sentence: AudiobookSentence, generationId: string) => {
    stopAudiobookPlayback();
    setPlayingGenerationId(generationId);
    setPlayingSentenceId(sentence.id);
    setPlaybackIntent('playing');
  };

  const selectAudioTake = async (sentence: AudiobookSentence, generationId: string) => {
    try {
      await apiClient.selectAudiobookSentenceAudio(sentence.id, generationId);
      await refresh();
      toast({ title: '已切换该句使用的语音' });
    } catch (error) {
      toast({ title: '切换语音失败', description: String(error), variant: 'destructive' });
    }
  };

  const deleteAudioTake = async (sentence: AudiobookSentence, generationId: string) => {
    if (!window.confirm('删除这条语音？音频文件和生成记录将被永久删除。')) return;
    try {
      stopAudiobookPlayback();
      await apiClient.deleteAudiobookSentenceAudioTake(sentence.id, generationId);
      await refresh();
      toast({ title: '语音已删除' });
    } catch (error) {
      toast({ title: '删除语音失败', description: String(error), variant: 'destructive' });
    }
  };

  const permanentlyDeleteSentence = async (deletionId: string) => {
    if (!window.confirm('永久删除这句话及其关联语音？此操作无法撤销。')) return;
    try {
      stopAudiobookPlayback();
      await apiClient.permanentlyDeleteAudiobookSentence(deletionId);
      await refresh();
      toast({ title: '已永久删除' });
    } catch (error) {
      toast({ title: '永久删除失败', description: String(error), variant: 'destructive' });
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

  const startEditing = (items: AudiobookSentence[]) => {
    setSentenceDrafts((current) => ({
      ...current,
      ...Object.fromEntries(items.map((item) => [item.id, current[item.id] ?? item.text])),
    }));
    setEditingSentenceIds((current) => new Set([...current, ...items.map((item) => item.id)]));
  };

  const cancelEditing = (sentenceId: string) => {
    setEditingSentenceIds((current) => {
      const next = new Set(current);
      next.delete(sentenceId);
      return next;
    });
    setSentenceDrafts((current) => {
      const next = { ...current };
      delete next[sentenceId];
      return next;
    });
  };

  const saveSentence = async (sentence: AudiobookSentence) => {
    const text = (sentenceDrafts[sentence.id] ?? sentence.text).trim();
    if (!text) {
      toast({ title: '句子不能为空', variant: 'destructive' });
      return false;
    }
    try {
      if (text !== sentence.text) await apiClient.updateAudiobookSentence(sentence.id, { text });
      cancelEditing(sentence.id);
      return true;
    } catch (error) {
      toast({ title: '修改句子失败', description: String(error), variant: 'destructive' });
      return false;
    }
  };

  const saveSelectedEdits = async () => {
    const targets = sentences.filter((item) => editingSentenceIds.has(item.id));
    for (const sentence of targets) await saveSentence(sentence);
    await refresh();
  };

  const stopAudiobookPlayback = () => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    setPlayingSentenceId(null);
    setPlayingGenerationId(null);
    setPlaybackIntent('stopped');
    setIsPlaying(false);
  };

  const deleteSentence = (sentence: AudiobookSentence) => {
    setDeleteRequest({ type: 'single', sentence });
  };

  const confirmDeleteSentence = async (sentence: AudiobookSentence) => {
    try {
      stopAudiobookPlayback();
      const result = await apiClient.deleteAudiobookSentence(sentence.id);
      await refresh();
      toast({
        title: '句子已删除',
        description: '可在短时间内撤销并恢复原语音绑定。',
        action: (
          <ToastAction
            altText="撤销删除"
            onClick={async () => {
              await apiClient.restoreAudiobookSentence(sentence.chapter_id, result.snapshot);
              await refresh();
            }}
          >
            撤销
          </ToastAction>
        ),
      });
    } catch (error) {
      toast({ title: '删除句子失败', description: String(error), variant: 'destructive' });
    }
  };

  const deleteSelectedSentences = () => {
    const targets = sentences.filter((item) => selectedSentenceIds.has(item.id));
    if (!targets.length) return;
    setDeleteRequest({ type: 'selected', sentences: targets });
  };

  const confirmDeleteSelectedSentences = async (targets: AudiobookSentence[]) => {
    try {
      stopAudiobookPlayback();
      const { snapshots } = await apiClient.deleteAudiobookSentences(
        targets.map((sentence) => sentence.id),
      );
      setSelectedSentenceIds(new Set());
      await refresh();
      toast({
        title: `已删除 ${snapshots.length} 句话`,
        action: (
          <ToastAction
            altText="撤销批量删除"
            onClick={async () => {
              const deletionIds = snapshots.flatMap((snapshot) =>
                snapshot.deletion_id ? [snapshot.deletion_id] : [],
              );
              if (deletionIds.length === snapshots.length)
                await apiClient.restoreAudiobookSentences(chapter!.id, deletionIds);
              else
                for (const snapshot of [...snapshots].sort((a, b) => a.position - b.position))
                  await apiClient.restoreAudiobookSentence(chapter!.id, snapshot);
              await refresh();
            }}
          >
            撤销
          </ToastAction>
        ),
      });
    } catch (error) {
      toast({ title: '批量删除失败', description: String(error), variant: 'destructive' });
    }
  };

  const confirmDeleteRequest = async () => {
    const request = deleteRequest;
    if (!request) return;
    setDeleteRequest(null);
    if (request.type === 'single') await confirmDeleteSentence(request.sentence);
    else await confirmDeleteSelectedSentences(request.sentences);
  };

  const restoreDeletedSentences = async (deletionIds: string[]) => {
    if (!chapter || !deletionIds.length) return;
    try {
      await apiClient.restoreAudiobookSentences(chapter.id, deletionIds);
      await refresh();
      toast({ title: `已恢复 ${deletionIds.length} 句话` });
    } catch (error) {
      toast({ title: '恢复句子失败', description: String(error), variant: 'destructive' });
    }
  };

  const mergeSelectedSentences = async () => {
    const targets = sentences.filter((item) => selectedSentenceIds.has(item.id));
    if (targets.length < 2) return;
    const first = targets[0];
    try {
      await apiClient.updateAudiobookSentence(first.id, {
        text: targets.map((item) => sentenceDrafts[item.id] ?? item.text).join(''),
      });
      for (const sentence of [...targets.slice(1)].reverse())
        await apiClient.deleteAudiobookSentence(sentence.id);
      setSelectedSentenceIds(new Set([first.id]));
      await refresh();
    } catch (error) {
      toast({ title: '合并句子失败', description: String(error), variant: 'destructive' });
    }
  };

  const splitSelectedSentence = async () => {
    const target = sentences.find((item) => selectedSentenceIds.has(item.id));
    if (selectedSentenceIds.size !== 1 || !target) return;
    const parts = (sentenceDrafts[target.id] ?? target.text)
      .split(/\n+/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (parts.length < 2) {
      startEditing([target]);
      toast({ title: '请在编辑框中用换行标出拆分位置，再点击“按换行拆分”' });
      return;
    }
    try {
      await apiClient.updateAudiobookSentence(target.id, { text: parts[0] });
      for (let index = 1; index < parts.length; index += 1)
        await apiClient.createAudiobookSentence(target.chapter_id, {
          text: parts[index],
          position: target.position + index,
          paragraph_index: target.paragraph_index,
        });
      cancelEditing(target.id);
      setSelectedSentenceIds(new Set());
      await refresh();
    } catch (error) {
      toast({ title: '拆分句子失败', description: String(error), variant: 'destructive' });
    }
  };

  const reorderSentences = async ({ active, over }: DragEndEvent) => {
    if (!chapter || !over || active.id === over.id) return;
    const oldIndex = sentences.findIndex((item) => item.id === active.id);
    const newIndex = sentences.findIndex((item) => item.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const reordered = arrayMove(sentences, oldIndex, newIndex);
    queryClient.setQueryData(
      ['audiobook', bookId],
      book
        ? {
            ...book,
            chapters: book.chapters.map((item) =>
              item.id === chapter.id
                ? {
                    ...item,
                    sentences: reordered.map((sentence, position) => ({ ...sentence, position })),
                  }
                : item,
            ),
          }
        : book,
    );
    try {
      await apiClient.reorderAudiobookSentences(
        chapter.id,
        reordered.map((item) => item.id),
      );
      await refresh();
    } catch (error) {
      toast({ title: '调整顺序失败', description: String(error), variant: 'destructive' });
      await refresh();
    }
  };

  const generateTargets = async (targets: AudiobookSentence[]) => {
    const selectedProfile = compatibleProfiles.find((item) => item.id === profileId);
    if (!selectedProfile) {
      toast({
        title: '当前声音无效',
        description: '请选择一个仍然存在且兼容当前模型的声音。',
        variant: 'destructive',
      });
      return;
    }
    const validProfileIds = new Set((profilesQuery.data ?? []).map((item) => item.id));
    if (targets.some((item) => item.profile_id && !validProfileIds.has(item.profile_id)))
      toast({
        title: '检测到失效的旧声音绑定',
        description: `将改用当前声音“${selectedProfile.name}”重新生成。`,
      });
    if (!bookId || !chapter || !targets.length) return;
    // Synthesis and playback are deliberately independent. Clearing the
    // player's explicit intent here prevents generation_id/status changes
    // from ever being interpreted as a request to play newly created audio.
    stopAudiobookPlayback();
    setGenerating(true);
    stopRequestedRef.current = false;
    try {
      await apiClient.createAudiobookGenerationPlan(bookId, {
        chapter_id: chapter.id,
        sentence_ids: targets.map((sentence) => sentence.id),
        profile_id: profileId,
        language,
        engine: engine || 'qwen',
        model_size: modelSize,
        instruct: engine === 'qwen_custom_voice' ? instruct || undefined : undefined,
        performance_mode: performanceMode,
      });
      await activePlanQuery.refetch();
      toast({
        title: `已安排 ${targets.length} 句话`,
        description: '生成计划已保存，重启软件后仍会继续。',
      });
    } catch (error) {
      setGenerating(false);
      toast({ title: '创建生成计划失败', description: String(error), variant: 'destructive' });
    }
  };

  const generateAll = async (onlyFailed = false) =>
    generateTargets(
      sentences.filter((s) =>
        onlyFailed
          ? s.generation_status === 'failed'
          : !s.generation_id || s.generation_status === 'failed',
      ),
    );

  const generateSelected = async () =>
    generateTargets(sentences.filter((item) => selectedSentenceIds.has(item.id)));

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
    const sentence = sentences[index];
    if (!sentence) return;
    if (sentence.generation_status !== 'completed' || !sentence.generation_id) {
      toast({
        title: '该句尚无可播放语音',
        description: '生成完成后不会自动播放，请届时手动点击播放。',
      });
      return;
    }
    setPlayingGenerationId(null);
    if (playingSentenceId === sentence.id && playbackIntent === 'playing') {
      audioRef.current?.pause();
      setPlaybackIntent('paused');
      setIsPlaying(false);
      return;
    }
    if (playingSentenceId === sentence.id && audioRef.current) {
      setPlaybackIntent('playing');
      audioRef.current
        .play()
        .then(() => setIsPlaying(true))
        .catch(() => setIsPlaying(false));
      return;
    }
    setPlayingSentenceId(sentence.id);
    setPlaybackIntent('playing');
  };
  const playAdjacent = (delta: number) => {
    if (playingIndex < 0) return;
    const next = playingIndex + delta;
    if (next >= 0 && next < sentences.length) {
      setPlayingGenerationId(null);
      setPlayingSentenceId(sentences[next].id);
      setPlaybackIntent('playing');
    }
  };
  const onEnded = () => {
    if (playingIndex < 0 || playbackIntent !== 'playing') return;
    const next = sentences.findIndex(
      (s, i) => i > playingIndex && s.generation_status === 'completed' && !!s.generation_id,
    );
    if (next >= 0) {
      setPlayingGenerationId(null);
      setPlayingSentenceId(sentences[next].id);
    } else {
      setPlaybackIntent('stopped');
      setIsPlaying(false);
    }
  };

  const jumpToSentence = (position: number) => {
    if (!sentences.length) return;
    const targetIndex = Math.min(Math.max(position, 0), sentences.length - 1);
    const target = sentences[targetIndex];
    setSentenceFilter('all');
    window.requestAnimationFrame(() => {
      rowRefs.current.get(target.id)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    setJumpPosition(String(targetIndex + 1));
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const element = event.target as HTMLElement | null;
      const isEditingText = element?.tagName === 'TEXTAREA' || element?.tagName === 'INPUT';
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveSelectedEdits();
      } else if (event.key === 'Escape' && editingSentenceIds.size) {
        setEditingSentenceIds(new Set());
        setSentenceDrafts({});
      } else if (event.key === 'Delete' && selectedSentenceIds.size && !isEditingText) {
        event.preventDefault();
        void deleteSelectedSentences();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [editingSentenceIds, selectedSentenceIds, sentenceDrafts, sentences]);

  const generationSettings = (
    <div className="space-y-5">
      <ModelRuntimeControl modelName={engineModelName(engine || 'qwen', modelSize)} />
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
        {compatibleProfiles.length === 0 && (
          <p role="status" className="text-xs text-amber-600">
            {engine === 'qwen_voice_design'
              ? 'VoiceDesign 需要设计声音，请先到声音页面通过文字描述创建。已有克隆声音请使用 Qwen3-TTS Base。'
              : '没有兼容此引擎的声音，请先创建或切换引擎。'}
          </p>
        )}
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
      <div className="space-y-2">
        <Label>批量性能模式</Label>
        <Select
          value={performanceMode}
          onValueChange={(value) => setPerformanceMode(value as 'stable' | 'fast')}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="stable">稳定模式（逐句提交）</SelectItem>
            <SelectItem value="fast">快速模式（提前排队）</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">
          快速模式提前提交后续句子，适合确定无需修改的章节；稳定模式逐句提交，便于随时调整。
        </p>
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
      {!!chapter && completedCount > 0 && (
        <div className="space-y-2 rounded-lg border p-3">
          <Label>导出整章</Label>
          <div className="flex items-center gap-2">
            <Input
              className="min-w-0 flex-1"
              type="number"
              min="0"
              max="10000"
              value={exportPauseMs}
              onChange={(event) => setExportPauseMs(event.target.value)}
            />
            <span className="shrink-0 text-xs text-muted-foreground">毫秒停顿</span>
          </div>
          <Button
            className="w-full"
            variant="outline"
            disabled={exporting}
            onClick={async () => {
              setExporting(true);
              try {
                const blob = await apiClient.exportAudiobookChapter(
                  chapter.id,
                  Number(exportPauseMs) || 0,
                );
                await platform.filesystem.saveFile(`${chapter.title || 'chapter'}.wav`, blob, [
                  { name: 'WAV 音频', extensions: ['wav'] },
                ]);
                toast({ title: '整章音频已导出' });
              } catch (error) {
                toast({
                  title: '导出整章失败',
                  description: String(error),
                  variant: 'destructive',
                });
              } finally {
                setExporting(false);
              }
            }}
          >
            {exporting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {exporting ? '正在合并并保存…' : '导出整章 WAV'}
          </Button>
        </div>
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
    </div>
  );

  return (
    <div ref={pageRef} className="audiobooks-page">
      <div
        className={cn('audiobooks-workspace', playingIndex >= 0 && currentSentence && 'has-player')}
      >
        <aside className="audiobook-library">
          <div className="audiobook-library-heading flex items-center justify-between gap-3">
            <h2 className="text-xl font-bold">有声图书</h2>
            <Button
              size="icon"
              variant="outline"
              aria-label="新建图书"
              onClick={() => setNewBookOpen(true)}
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
          <div className="audiobook-library-select min-w-0">
            <Select value={bookId ?? ''} onValueChange={setBookId}>
              <SelectTrigger aria-label="选择图书">
                <SelectValue placeholder="选择一本图书" />
              </SelectTrigger>
              <SelectContent>
                {(booksQuery.data ?? []).map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="mt-5 mb-2 flex items-center justify-between text-xs text-muted-foreground">
            <span>章节目录</span>
            <span>{book?.chapters.length ?? 0} 章</span>
          </div>
          <nav aria-label="章节目录" className="audiobook-library-list space-y-1 overflow-y-auto">
            {(book?.chapters ?? []).map((item, index) => (
              <button
                type="button"
                key={item.id}
                onClick={() => setChapterId(item.id)}
                aria-current={item.id === chapter?.id ? 'page' : undefined}
                className={cn(
                  'w-full text-left rounded-md px-3 py-3 hover:bg-muted/50',
                  item.id === chapter?.id && 'bg-primary/10 text-primary',
                )}
              >
                <div className="font-medium truncate">
                  {index + 1}. {item.title}
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {item.sentences.length} 句 · 已生成{' '}
                  {
                    item.sentences.filter((sentence) => sentence.generation_status === 'completed')
                      .length
                  }
                </div>
              </button>
            ))}
            {!booksQuery.isLoading && !booksQuery.data?.length && (
              <div className="text-center text-sm text-muted-foreground py-12">
                <BookOpen className="h-9 w-9 mx-auto mb-3" />
                创建第一本有声图书
              </div>
            )}
          </nav>
          {book && (
            <Button variant="outline" className="mt-3 shrink-0" onClick={addChapter}>
              <Plus className="mr-2 h-4 w-4" />
              新增章节
            </Button>
          )}
        </aside>

        <main className="audiobook-editor min-w-0 min-h-0 flex flex-col">
          {!book || !chapter ? (
            <div className="h-full flex items-center justify-center text-muted-foreground">
              请新建或选择一本图书
            </div>
          ) : (
            <>
              <div className="shrink-0 mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="mb-1 text-xs text-muted-foreground truncate">
                    {book.title}
                    {book.author ? ` · ${book.author}` : ''}
                  </div>
                  <div className="flex min-w-0 items-baseline gap-3">
                    <h1 className="min-w-0 truncate text-xl font-semibold" title={chapter.title}>
                      {chapter.title}
                    </h1>
                    <span
                      className="min-w-0 truncate text-sm text-muted-foreground"
                      title="当前章节字数"
                    >
                      {sentences
                        .reduce((total, sentence) => total + sentence.text.length, 0)
                        .toLocaleString()}{' '}
                      字
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {generating || bookActiveCount > 0 ? (
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={stopping}
                      onClick={stopGeneration}
                    >
                      <Square className="mr-2 h-4 w-4" />
                      {stopping ? '正在停止…' : '停止生成'}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      disabled={!sentences.length || !profileId}
                      onClick={() => generateAll(false)}
                    >
                      <Volume2 className="mr-2 h-4 w-4" />
                      生成本章
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={() => setSettingsOpen(true)}>
                    <Settings2 className="mr-2 h-4 w-4" />
                    声音与设置
                  </Button>
                </div>
                <div className="basis-full text-xs text-muted-foreground">
                  下次生成：
                  {compatibleProfiles.find((profile) => profile.id === profileId)?.name ||
                    '尚未选择声音'}{' '}
                  · {ENGINES.find(([value]) => value === engineValue)?.[1]}
                  {generating ? ' · 当前批次按提交时的设置继续' : ''}
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
                  <div className="audiobook-toolbar shrink-0 rounded-xl border bg-card p-3 mb-3 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm">
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
                    {processingIndex >= 0 && sentences[processingIndex].generation_id && (
                      <GenerationProgress
                        id={sentences[processingIndex].generation_id!}
                        loadingModel={
                          sentences[processingIndex].generation_status === 'loading_model'
                        }
                        progress={sentences[processingIndex].generation_progress}
                      />
                    )}
                    <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
                      <span>未处理 {pendingCount}</span>
                      <span className="text-blue-500">处理中 {activeCount}</span>
                      <span className="text-emerald-500">已完成 {completedCount}</span>
                      <span className={failedCount ? 'text-destructive' : undefined}>
                        失败 {failedCount}
                      </span>
                    </div>
                    <div className="audiobook-toolbar-navigation">
                      <Select value={sentenceFilter} onValueChange={setSentenceFilter}>
                        <SelectTrigger className="h-7 w-24 text-xs" aria-label="筛选句子">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">全部</SelectItem>
                          <SelectItem value="pending">未生成</SelectItem>
                          <SelectItem value="processing">生成中</SelectItem>
                          <SelectItem value="completed">已完成</SelectItem>
                          <SelectItem value="failed">失败</SelectItem>
                          <SelectItem value="modified">已修改</SelectItem>
                        </SelectContent>
                      </Select>
                      <div className="flex max-w-full items-center gap-0 overflow-x-auto rounded-md border px-0.5">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          title="回到顶部"
                          onClick={() => jumpToSentence(0)}
                        >
                          <ChevronsUp className="h-4 w-4" />
                        </Button>
                        <Input
                          value={jumpPosition}
                          onChange={(event) =>
                            setJumpPosition(event.target.value.replace(/\D/g, ''))
                          }
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' && jumpPosition)
                              jumpToSentence(Number(jumpPosition) - 1);
                          }}
                          className="h-7 w-14 border-0 px-1 text-center text-xs shadow-none"
                          placeholder={`1-${sentences.length}`}
                          aria-label="跳转到句子编号"
                        />
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2"
                          disabled={!jumpPosition}
                          onClick={() => jumpToSentence(Number(jumpPosition) - 1)}
                        >
                          跳转
                        </Button>
                        {processingIndex >= 0 && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2"
                            onClick={() => jumpToSentence(processingIndex)}
                          >
                            定位处理中
                          </Button>
                        )}
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          title="前往底部"
                          onClick={() => jumpToSentence(sentences.length - 1)}
                        >
                          <ChevronsDown className="h-4 w-4" />
                        </Button>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="audiobook-toolbar-button"
                        onClick={() =>
                          setSelectedSentenceIds(
                            selectedSentenceIds.size === sentences.length
                              ? new Set()
                              : new Set(sentences.map((item) => item.id)),
                          )
                        }
                      >
                        {selectedSentenceIds.size === sentences.length ? '取消全选' : '全选'}
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="audiobook-toolbar-button ml-auto"
                            aria-label="章节工具"
                          >
                            <MoreHorizontal className="h-3.5 w-3.5" />
                            章节工具
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => addSentence(sentences.length)}>
                            <Plus className="mr-2 h-4 w-4" />
                            末尾新增句子
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => setRecycleBinOpen(true)}>
                            <RotateCcw className="mr-2 h-4 w-4" />
                            回收站
                            {deletedSentencesQuery.data?.length
                              ? ` (${deletedSentencesQuery.data.length})`
                              : ''}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    {(selectedSentenceIds.size > 0 || editingSentenceIds.size > 0) && (
                      <div
                        className="audiobook-selection-toolbar"
                        role="group"
                        aria-label="句子批量操作"
                      >
                        {selectedSentenceIds.size > 0 && (
                          <>
                            <span className="whitespace-nowrap text-xs text-muted-foreground tabular-nums">
                              已选 {selectedSentenceIds.size} 句
                            </span>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="audiobook-toolbar-button"
                              onClick={() =>
                                startEditing(
                                  sentences.filter((item) => selectedSentenceIds.has(item.id)),
                                )
                              }
                            >
                              <Pencil className="h-3.5 w-3.5" />
                              编辑所选
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              className="audiobook-toolbar-button"
                              onClick={generateSelected}
                              disabled={generating}
                            >
                              <Volume2 className="h-3.5 w-3.5" />
                              生成所选
                            </Button>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="audiobook-toolbar-button"
                                  aria-label="更多所选句子操作"
                                >
                                  <MoreHorizontal className="h-3.5 w-3.5" />
                                  更多
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="start">
                                <DropdownMenuItem
                                  onSelect={mergeSelectedSentences}
                                  disabled={selectedSentenceIds.size < 2}
                                >
                                  合并所选句子
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onSelect={splitSelectedSentence}
                                  disabled={selectedSentenceIds.size !== 1}
                                >
                                  按换行拆分
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  className="text-destructive focus:text-destructive"
                                  onSelect={deleteSelectedSentences}
                                >
                                  <Trash2 className="mr-2 h-4 w-4" />
                                  删除所选
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </>
                        )}
                        {editingSentenceIds.size > 0 && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="audiobook-toolbar-button ml-auto"
                            onClick={saveSelectedEdits}
                            title="保存全部编辑 (Ctrl+S)"
                          >
                            <Check className="h-3.5 w-3.5" />
                            保存编辑 ({editingSentenceIds.size})
                          </Button>
                        )}
                        {selectedSentenceIds.size > 0 && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 shrink-0 rounded-md"
                            onClick={() => setSelectedSentenceIds(new Set())}
                            aria-label="取消选择"
                            title="取消选择"
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                  <div
                    ref={sentenceListRef}
                    className="audiobook-sentences flex-1 min-h-0 pr-2 space-y-1"
                    role="region"
                    aria-label="章节正文列表"
                    tabIndex={0}
                  >
                    <DndContext
                      sensors={dragSensors}
                      collisionDetection={closestCenter}
                      onDragEnd={reorderSentences}
                    >
                      <SortableContext
                        items={visibleSentences.map((item) => item.id)}
                        strategy={verticalListSortingStrategy}
                      >
                        {visibleSentences.map((sentence) => {
                          const index = sentences.findIndex((item) => item.id === sentence.id);
                          const active = index === playingIndex;
                          const status = sentence.generation_status;
                          const isProcessing = ['generating', 'loading_model'].includes(
                            status || '',
                          );
                          const phase = sentence.generation_progress?.stage;
                          const phaseLabel =
                            phase &&
                            {
                              queued: '排队中',
                              loading_model: '载入模型',
                              preparing_voice: '准备声音',
                              generating: '生成中',
                              finalizing: '保存音频',
                            }[phase];
                          const statusLabel =
                            active && isPlaying
                              ? '正在播放'
                              : status === 'completed'
                                ? '已完成'
                                : isProcessing && phaseLabel
                                  ? phaseLabel
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
                            <SortableSentenceRow
                              id={sentence.id}
                              disabled={
                                sentenceFilter !== 'all' ||
                                isProcessing ||
                                editingSentenceIds.has(sentence.id)
                              }
                              rowRef={(el) => {
                                if (el) rowRefs.current.set(sentence.id, el);
                                else rowRefs.current.delete(sentence.id);
                              }}
                              key={sentence.id}
                              onClick={() => status === 'completed' && playFrom(index)}
                              className={cn(
                                'audiobook-sentence w-full text-left rounded-lg px-3 py-3 border border-transparent transition-colors',
                                status === 'completed' && 'hover:bg-muted/50 cursor-pointer',
                                active && 'bg-primary/10 border-primary/40 shadow-sm',
                              )}
                            >
                              <input
                                type="checkbox"
                                className="mt-1 h-4 w-4 accent-primary"
                                checked={selectedSentenceIds.has(sentence.id)}
                                aria-label={`选择第 ${index + 1} 句`}
                                onClick={(event) => event.stopPropagation()}
                                onChange={(event) => {
                                  setSelectedSentenceIds((current) => {
                                    const next = new Set(current);
                                    if (event.target.checked) next.add(sentence.id);
                                    else next.delete(sentence.id);
                                    return next;
                                  });
                                }}
                              />
                              <span className="text-xs text-muted-foreground pt-1 tabular-nums">
                                {String(index + 1).padStart(3, '0')}
                              </span>
                              <span className="audiobook-sentence-body min-w-0">
                                {editingSentenceIds.has(sentence.id) ? (
                                  <span className="block">
                                    <Textarea
                                      value={sentenceDrafts[sentence.id] ?? sentence.text}
                                      className="min-h-20 resize-y leading-6"
                                      autoFocus
                                      onClick={(event) => event.stopPropagation()}
                                      onChange={(event) =>
                                        setSentenceDrafts((current) => ({
                                          ...current,
                                          [sentence.id]: event.target.value,
                                        }))
                                      }
                                    />
                                    {(sentenceDrafts[sentence.id] ?? sentence.text) !==
                                      sentence.text && (
                                      <span className="mt-1 inline-block rounded bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-600">
                                        未保存
                                      </span>
                                    )}
                                  </span>
                                ) : (
                                  <span
                                    className={cn(
                                      'block leading-7',
                                      active && 'text-primary font-medium',
                                    )}
                                  >
                                    {sentence.text}
                                  </span>
                                )}
                                {status === 'failed' && sentence.generation_error && (
                                  <span className="block text-xs text-destructive mt-1 line-clamp-2">
                                    {sentence.error_category && `[${sentence.error_category}] `}
                                    {sentence.generation_error}
                                  </span>
                                )}
                                {!!sentence.generation_id && (
                                  <span className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                                    <span>时长：{formatDuration(sentence.duration)}</span>
                                    <span>声音：{sentence.profile_name || '—'}</span>
                                    <span>
                                      模型：{sentence.engine || '—'}
                                      {sentence.model_size ? ` ${sentence.model_size}` : ''}
                                    </span>
                                    <span
                                      className="sr-only"
                                      title={
                                        sentence.audio_path ||
                                        (sentence.generation_status === 'completed'
                                          ? `generations\\${sentence.generation_id}.wav`
                                          : '尚未生成文件')
                                      }
                                    >
                                      文件：
                                      {sentence.audio_path ||
                                        (sentence.generation_status === 'completed'
                                          ? `generations\\${sentence.generation_id}.wav`
                                          : '尚未生成')}
                                    </span>
                                  </span>
                                )}
                                {(sentence.audio_takes?.length ?? 0) > 0 && (
                                  <details
                                    className="mt-2 space-y-1 text-xs"
                                    onClick={(event) => event.stopPropagation()}
                                  >
                                    <summary className="cursor-pointer text-muted-foreground py-1">
                                      语音版本（{sentence.audio_takes.length}）
                                    </summary>
                                    {sentence.audio_takes.map((take, takeIndex) => (
                                      <span
                                        key={take.generation_id}
                                        className={cn(
                                          'audiobook-audio-take flex flex-wrap items-center gap-2 rounded px-2 py-1 text-[11px]',
                                          take.selected && 'bg-primary/10 text-primary',
                                        )}
                                        onClick={(event) => event.stopPropagation()}
                                      >
                                        <span className="min-w-0 basis-32 flex-1 truncate">
                                          版本 {takeIndex + 1} · {take.profile_name || '未知声音'} ·{' '}
                                          {take.engine || '—'}
                                          {take.model_size ? ` ${take.model_size}` : ''} ·{' '}
                                          {formatDuration(take.duration)}
                                        </span>
                                        {take.selected && <span className="font-medium">当前</span>}
                                        {take.status === 'completed' && (
                                          <Button
                                            size="icon"
                                            variant="ghost"
                                            className="h-6 w-6"
                                            title="试听这条语音"
                                            onClick={() =>
                                              playAudioTake(sentence, take.generation_id)
                                            }
                                          >
                                            <Play className="h-3 w-3" />
                                          </Button>
                                        )}
                                        {!take.selected && take.status === 'completed' && (
                                          <Button
                                            size="sm"
                                            variant="ghost"
                                            className="h-6 px-2 text-[11px]"
                                            onClick={() =>
                                              void selectAudioTake(sentence, take.generation_id)
                                            }
                                          >
                                            设为当前
                                          </Button>
                                        )}
                                        <Button
                                          size="icon"
                                          variant="ghost"
                                          className="h-6 w-6 text-destructive"
                                          title="删除这条语音"
                                          onClick={() =>
                                            void deleteAudioTake(sentence, take.generation_id)
                                          }
                                        >
                                          <Trash2 className="h-3 w-3" />
                                        </Button>
                                      </span>
                                    ))}
                                  </details>
                                )}
                              </span>
                              <span className="audiobook-sentence-actions flex flex-wrap justify-end items-center gap-2 text-xs text-muted-foreground">
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
                                    isProcessing &&
                                      'border-blue-500/40 bg-blue-500/10 text-blue-500',
                                    status === 'completed' &&
                                      'border-emerald-500/40 bg-emerald-500/10 text-emerald-500',
                                    status === 'failed' &&
                                      'border-destructive/40 bg-destructive/10 text-destructive',
                                    active &&
                                      isPlaying &&
                                      'border-primary/40 bg-primary/10 text-primary',
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
                                {editingSentenceIds.has(sentence.id) ? (
                                  <>
                                    <Button
                                      size="icon"
                                      variant="ghost"
                                      className="h-7 w-7 text-emerald-500"
                                      title="保存修改"
                                      onClick={async (e) => {
                                        e.stopPropagation();
                                        if (await saveSentence(sentence)) await refresh();
                                      }}
                                    >
                                      <Check className="h-3.5 w-3.5" />
                                    </Button>
                                    <Button
                                      size="icon"
                                      variant="ghost"
                                      className="h-7 w-7"
                                      title="取消修改"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        cancelEditing(sentence.id);
                                      }}
                                    >
                                      <X className="h-3.5 w-3.5" />
                                    </Button>
                                  </>
                                ) : (
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    className="h-7 w-7"
                                    disabled={isProcessing}
                                    title="行内编辑句子"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      startEditing([sentence]);
                                    }}
                                  >
                                    <Pencil className="h-3.5 w-3.5" />
                                  </Button>
                                )}
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
                            </SortableSentenceRow>
                          );
                        })}
                      </SortableContext>
                    </DndContext>
                  </div>
                </div>
              )}
            </>
          )}
        </main>
      </div>

      {playingIndex >= 0 && currentSentence && (
        <AudiobookPlayer
          sentence={currentSentence}
          index={playingIndex}
          total={sentences.length}
          isPlaying={isPlaying}
          rate={rate}
          audioRef={audioRef}
          onToggle={() => playFrom(playingIndex)}
          onPrevious={() => playAdjacent(-1)}
          onNext={() => playAdjacent(1)}
          onRateChange={setRate}
        />
      )}
      {/* biome-ignore lint/a11y/useMediaCaption: the synchronized spoken text is visible and highlighted above. */}
      <audio
        ref={audioRef}
        onEnded={onEnded}
        onPause={() => setIsPlaying(false)}
        onPlay={() => setIsPlaying(true)}
      />

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="fixed left-auto right-0 top-0 h-dvh max-h-dvh w-full max-w-md translate-x-0 translate-y-0 rounded-none flex flex-col">
          <DialogHeader className="shrink-0">
            <DialogTitle>声音与生成设置</DialogTitle>
            <DialogDescription>
              选择本次生成使用的声音与模型。已保存的语音不会随设置改变。
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto pr-2">{generationSettings}</div>
        </DialogContent>
      </Dialog>

      <Dialog open={recycleBinOpen} onOpenChange={setRecycleBinOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>句子回收站</DialogTitle>
          </DialogHeader>
          <div className="max-h-[55vh] overflow-y-auto space-y-2 pr-2">
            {!deletedSentencesQuery.data?.length ? (
              <p className="py-8 text-center text-sm text-muted-foreground">回收站为空</p>
            ) : (
              deletedSentencesQuery.data.map((item) => (
                <div
                  key={item.deletion_id}
                  className="flex items-start gap-3 rounded-lg border p-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-muted-foreground mb-1">
                      原第 {item.position + 1} 句
                    </div>
                    <div className="text-sm break-words">{item.text}</div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void restoreDeletedSentences([item.deletion_id])}
                  >
                    恢复
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => void permanentlyDeleteSentence(item.deletion_id)}
                  >
                    永久删除
                  </Button>
                </div>
              ))
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRecycleBinOpen(false)}>
              关闭
            </Button>
            {!!deletedSentencesQuery.data?.length && (
              <Button
                onClick={() =>
                  void restoreDeletedSentences(
                    deletedSentencesQuery.data.map((item) => item.deletion_id),
                  )
                }
              >
                全部恢复
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteRequest !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteRequest(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认删除句子</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {deleteRequest?.type === 'selected'
              ? `确定删除选中的 ${deleteRequest.sentences.length} 句话吗？删除后可在短时间内撤销。`
              : `确定删除第 ${(deleteRequest?.sentence.position ?? 0) + 1} 句吗？删除后可在短时间内撤销。`}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteRequest(null)}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => void confirmDeleteRequest()}>
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
