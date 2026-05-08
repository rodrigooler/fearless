use criterion::{black_box, criterion_group, criterion_main, Criterion};
use fearless_core::benchmark::parser::{classify, parse_pipeline, Classification, Route};
use fearless_core::benchmark::responses::{BenchmarkResponses, Variant};

fn bench_classify(c: &mut Criterion) {
    let line = b"GET /plaintext HTTP/1.1\r\n";
    c.bench_function("classify_plaintext", |b| {
        b.iter(|| black_box(classify(black_box(line))))
    });
}

fn bench_pipeline(c: &mut Criterion) {
    let mut buf = Vec::new();
    for _ in 0..16 {
        buf.extend_from_slice(b"GET /plaintext HTTP/1.1\r\nHost: x\r\n\r\n");
    }
    c.bench_function("parse_pipeline_16", |b| {
        let mut out = [Classification { route: Route::NotFound, close: false }; 16];
        b.iter(|| black_box(parse_pipeline(black_box(&buf), &mut out)));
    });
}

fn bench_response_lookup(c: &mut Criterion) {
    let resp = BenchmarkResponses::new();
    c.bench_function("snapshot_get_plaintext", |b| {
        b.iter(|| {
            let snap = resp.snapshot();
            black_box(snap.get(Variant::PlaintextKeepalive));
        })
    });
}

criterion_group!(benches, bench_classify, bench_pipeline, bench_response_lookup);
criterion_main!(benches);
