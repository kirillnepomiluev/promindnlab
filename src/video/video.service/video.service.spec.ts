import { Test, TestingModule } from '@nestjs/testing';
import { VideoService } from './video.service';
import { ConfigService } from '@nestjs/config';

describe('VideoService', () => {
  let service: VideoService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideoService,
                         {
                   provide: ConfigService,
                   useValue: {
                     get: jest.fn((key: string) => {
                       if (key === 'KLING_ACCESS_KEY') return 'test-access-key';
                       if (key === 'KLING_SECRET_KEY') return 'test-secret-key';
                       if (key === 'KLING_API_URL') return 'https://api.kling.com';
                       return null;
                     }),
                   },
                 },
      ],
    }).compile();

    service = module.get<VideoService>(VideoService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
}); 