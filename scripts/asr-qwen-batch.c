/* Evaluation adapter only. Uses the unmodified upstream CPU API and exact
 * float32 PCM. Keeps one model resident; never reads human references. */
#include "qwen_asr.h"
#include "qwen_asr_kernels.h"
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sys/resource.h>

static double ms(void) {
    struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec * 1000.0 + t.tv_nsec / 1e6;
}
static double cpu(void) {
    struct rusage r; getrusage(RUSAGE_SELF, &r);
    return r.ru_utime.tv_sec + r.ru_stime.tv_sec +
        (r.ru_utime.tv_usec + r.ru_stime.tv_usec) / 1e6;
}
static long rss(void) {
    struct rusage r; getrusage(RUSAGE_SELF, &r); return r.ru_maxrss;
}
int main(int argc, char **argv) {
    if (argc < 3) return 2;
    qwen_verbose = 0;
    qwen_set_threads(qwen_get_num_cpus());
    double t = ms(), c = cpu();
    qwen_ctx_t *ctx = qwen_load(argv[1]);
    if (!ctx) return 3;
    printf("LOAD\t%.3f\t%.6f\t%ld\n", ms()-t, cpu()-c, rss()); fflush(stdout);
    for (int i=2; i<argc; i++) {
        FILE *f = fopen(argv[i], "rb"); if (!f) return 4;
        fseek(f,0,SEEK_END); long size=ftell(f); rewind(f);
        if (size <= 0 || size % sizeof(float)) return 5;
        float *pcm=malloc(size); if (!pcm) return 6;
        if (fread(pcm,1,size,f) != (size_t)size) return 7;
        fclose(f); t=ms(); c=cpu();
        char *text=qwen_transcribe_audio(ctx,pcm,(int)(size/sizeof(float)));
        double elapsed=ms()-t, used=cpu()-c;
        if (!text) return 8;
        /* Length-framed UTF-8 payload permits arbitrary tabs/newlines. */
        printf("RESULT\t%d\t%.3f\t%.6f\t%ld\t%d\t%.3f\t%.3f\t%zu\n",
            i-2,elapsed,used,rss(),ctx->perf_text_tokens,
            ctx->perf_encode_ms,ctx->perf_decode_ms,strlen(text));
        fwrite(text,1,strlen(text),stdout); putchar('\n'); fflush(stdout);
        free(text); free(pcm);
    }
    qwen_free(ctx); return 0;
}
