package com.ghatana.tts.grpc;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.tts.api.TtsEngine;
import com.ghatana.media.tts.api.VoiceInfo;
import com.ghatana.tts.core.grpc.proto.GetVoicesRequest;
import com.ghatana.tts.core.grpc.proto.GetVoicesResponse;
import com.ghatana.tts.core.grpc.proto.SynthesizeRequest;
import com.ghatana.tts.core.grpc.proto.SynthesizeResponse;
import io.grpc.Context;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.grpc.stub.StreamObserver;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.lang.reflect.Field;
import java.util.List;
import java.util.Locale;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** J-30 slice: informational voice inventory does not establish an admitted synthesis profile. */
@DisplayName("J-30 provider catalog unavailable boundary")
class J30ProviderCatalogUnavailableTest {
    private final AudioVideoLibrary library = mock(AudioVideoLibrary.class);
    private final TtsEngine engine = mock(TtsEngine.class);
    private Context identityContext;
    private Context previousContext;
    private TtsGrpcService service;

    @BeforeEach
    @SuppressWarnings("unchecked")
    void setUp() throws ReflectiveOperationException {
        Field identityKeyField = JwtServerInterceptor.class.getDeclaredField("VERIFIED_IDENTITY");
        identityKeyField.setAccessible(true);
        Context.Key<JwtServerInterceptor.VerifiedIdentity> identityKey =
                (Context.Key<JwtServerInterceptor.VerifiedIdentity>) identityKeyField.get(null);
        identityContext = Context.current().withValue(identityKey,
                new JwtServerInterceptor.VerifiedIdentity("j30-subject", "j30-tenant"));
        previousContext = identityContext.attach();
        when(library.getTtsEngine()).thenReturn(engine);
        // The listed entry is deliberately only test inventory metadata, not a qualified voice.
        when(engine.getAvailableVoices()).thenReturn(List.of(new VoiceInfo(
                "inventory-only-voice", "Inventory Voice", "informational engine entry",
                Locale.ENGLISH, VoiceInfo.Gender.NEUTRAL, 16_000, false, 1_024, 0.9f)));
        service = new TtsGrpcService(library, new SimpleMeterRegistry());
    }

    @AfterEach
    void detachIdentity() {
        if (identityContext != null) identityContext.detach(previousContext);
    }

    @Test
    @DisplayName("visible voice inventory remains NOT_ADMITTED and causes no synthesis effect")
    void visibleVoiceInventoryDoesNotAdmitSynthesis() {
        CapturingObserver<GetVoicesResponse> catalog = new CapturingObserver<>();
        service.getVoices(GetVoicesRequest.getDefaultInstance(), catalog);

        assertThat(catalog.value).isNotNull();
        assertThat(catalog.value.getVoicesList()).extracting(voice -> voice.getVoiceId())
                .containsExactly("inventory-only-voice");

        CapturingObserver<SynthesizeResponse> synthesis = new CapturingObserver<>();
        service.synthesize(SynthesizeRequest.newBuilder()
                .setText("J-30 boundary probe")
                .setVoiceId("inventory-only-voice")
                .build(), synthesis);

        assertThat(synthesis.error).isInstanceOf(StatusRuntimeException.class);
        StatusRuntimeException failure = (StatusRuntimeException) synthesis.error;
        assertThat(failure.getStatus().getCode()).isEqualTo(Status.UNAVAILABLE.getCode());
        assertThat(failure.getStatus().getDescription()).contains("NOT_ADMITTED");
        assertThat(synthesis.value).isNull();
        assertThat(synthesis.completed).isFalse();
        verify(engine, never()).synthesize(org.mockito.ArgumentMatchers.anyString(),
                org.mockito.ArgumentMatchers.any());
        verify(engine, never()).loadVoice(org.mockito.ArgumentMatchers.anyString());
    }

    private static final class CapturingObserver<T> implements StreamObserver<T> {
        private T value;
        private Throwable error;
        private boolean completed;

        @Override public void onNext(T response) { value = response; }
        @Override public void onError(Throwable failure) { error = failure; }
        @Override public void onCompleted() { completed = true; }
    }
}
