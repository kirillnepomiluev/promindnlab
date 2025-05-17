import { Test, TestingModule } from '@nestjs/testing';
import { OpenAiService } from './openai.service';

describe('OpenaiService', () => {
  let provider: OpenAiService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [OpenAiService],
    }).compile();

    provider = module.get<OpenAiService>(OpenAiService);
  });

  it('should be defined', () => {
    expect(provider).toBeDefined();
  });
});
