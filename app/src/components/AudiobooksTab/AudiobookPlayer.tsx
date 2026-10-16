import { ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react';
import type { RefObject } from 'react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { AudiobookSentence } from '@/lib/api/types';

interface AudiobookPlayerProps {
  sentence: AudiobookSentence;
  index: number;
  total: number;
  isPlaying: boolean;
  rate: string;
  audioRef: RefObject<HTMLAudioElement>;
  onToggle: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onRateChange: (rate: string) => void;
}

export function AudiobookPlayer({
  sentence,
  index,
  total,
  isPlaying,
  rate,
  audioRef,
  onToggle,
  onPrevious,
  onNext,
  onRateChange,
}: AudiobookPlayerProps) {
  return (
    <div className="audiobook-player absolute bottom-4 left-0 right-0 min-w-0 rounded-2xl border bg-card/95 backdrop-blur shadow-xl z-40 flex items-center gap-2 p-3">
      <Button
        size="icon"
        variant="ghost"
        className="shrink-0"
        aria-label="上一句"
        onClick={onPrevious}
        disabled={index <= 0}
      >
        <ChevronLeft />
      </Button>
      <Button
        size="icon"
        className="shrink-0"
        aria-label={isPlaying ? '暂停' : '播放'}
        onClick={onToggle}
      >
        {isPlaying ? <Pause /> : <Play />}
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="shrink-0"
        aria-label="下一句"
        onClick={onNext}
        disabled={index >= total - 1}
      >
        <ChevronRight />
      </Button>
      <div className="min-w-0 flex-1">
        <div className="text-sm truncate">{sentence.text}</div>
        <div className="text-xs text-muted-foreground mt-1">
          第 {index + 1} / {total} 句
        </div>
      </div>
      <Select
        value={rate}
        onValueChange={(value) => {
          onRateChange(value);
          if (audioRef.current) audioRef.current.playbackRate = Number(value);
        }}
      >
        <SelectTrigger className="w-20 shrink-0" aria-label="播放速度">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {['0.75', '1', '1.25', '1.5', '2'].map((value) => (
            <SelectItem key={value} value={value}>
              {value}×
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
