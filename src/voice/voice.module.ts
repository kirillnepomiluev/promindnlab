import { Module } from '@nestjs/common';
import { VoiceService } from './voice.service/voice.service';

@Module({
  providers: [VoiceService],
  exports: [VoiceService], // ← обязательно экспортируем!
})
export class VoiceModule {}
