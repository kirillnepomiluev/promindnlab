import { Module } from '@nestjs/common';
import { VideoService } from './video.service/video.service';
import { OpenaiModule } from '../openai/openai.module';

@Module({
  imports: [OpenaiModule],
  providers: [VideoService],
  exports: [VideoService],
})
export class VideoModule {}
