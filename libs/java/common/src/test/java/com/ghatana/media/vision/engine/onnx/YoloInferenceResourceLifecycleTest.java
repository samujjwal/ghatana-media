package com.ghatana.media.vision.engine.onnx;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class YoloInferenceResourceLifecycleTest {

    @Test
    void closesSessionResultBeforeInputAfterSuccessfulRead() throws Exception {
        List<String> closed = new ArrayList<>();
        FakeResource input = new FakeResource("input", closed, null);
        FakeResource result = new FakeResource("result", closed, null);

        String value = YoloOnnxEngine.withInferenceResources(input, FakeResource::close,
                ignored -> result, FakeResource::close, ignored -> "decoded");

        assertThat(value).isEqualTo("decoded");
        assertThat(closed).containsExactly("result", "input");
    }

    @Test
    void closesInputWhenSessionRunFails() {
        List<String> closed = new ArrayList<>();
        FakeResource input = new FakeResource("input", closed, null);
        IOException runFailure = new IOException("run failed");

        assertThatThrownBy(() -> YoloOnnxEngine.withInferenceResources(input, FakeResource::close,
                ignored -> { throw runFailure; }, FakeResource::close, ignored -> "unreachable"))
                .isSameAs(runFailure);

        assertThat(closed).containsExactly("input");
    }

    @Test
    void closesResultThenInputAndSuppressesCleanupFailuresAfterReadFailure() {
        List<String> closed = new ArrayList<>();
        IOException resultCloseFailure = new IOException("result close failed");
        IOException inputCloseFailure = new IOException("input close failed");
        FakeResource input = new FakeResource("input", closed, inputCloseFailure);
        FakeResource result = new FakeResource("result", closed, resultCloseFailure);
        IOException readFailure = new IOException("decode failed");

        assertThatThrownBy(() -> YoloOnnxEngine.withInferenceResources(input, FakeResource::close,
                ignored -> result, FakeResource::close, ignored -> { throw readFailure; }))
                .isSameAs(readFailure)
                .satisfies(failure -> assertThat(failure.getSuppressed())
                        .containsExactly(resultCloseFailure, inputCloseFailure));

        assertThat(closed).containsExactly("result", "input");
    }

    private static final class FakeResource implements AutoCloseable {
        private final String name;
        private final List<String> closed;
        private final IOException closeFailure;

        private FakeResource(String name, List<String> closed, IOException closeFailure) {
            this.name = name;
            this.closed = closed;
            this.closeFailure = closeFailure;
        }

        @Override
        public void close() throws IOException {
            closed.add(name);
            if (closeFailure != null) throw closeFailure;
        }
    }
}
