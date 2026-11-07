package com.ghatana.audio.video.vision.scenetext;

import org.junit.jupiter.api.Test;

import java.util.Collections;
import java.util.AbstractList;
import java.util.Iterator;
import java.util.NoSuchElementException;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThatThrownBy;

class DocumentIntelligenceV1BoundsTest {

    @Test
    void parsedDocumentRejectsMoreThanPublishedPageLimitBeforeCopy() {
        assertThatThrownBy(() -> new DocumentIntelligenceV1.ParsedDocument(
                DocumentIntelligenceV1.PROTOCOL_VERSION, "operation-1", "di.ocr.en", null,
                Collections.nCopies(DocumentIntelligenceV1.MAX_PAGES + 1, null)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("pages");
    }

    @Test
    void blockRejectsMoreThanPublishedConsumerLineLimitBeforeCopy() {
        assertThatThrownBy(() -> new DocumentIntelligenceV1.Block(
                "block-1", "text", null,
                Collections.nCopies(DocumentIntelligenceV1.MAX_LINES_PER_BLOCK + 1, null)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("lines");
    }

    @Test
    void providerCatalogRejectsMoreThanPublishedProviderLimitBeforeCopy() {
        assertThatThrownBy(() -> new DocumentIntelligenceV1.ProviderCatalog(
                DocumentIntelligenceV1.PROTOCOL_VERSION, null,
                Collections.nCopies(DocumentIntelligenceV1.MAX_PROVIDERS + 1, null)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("providers");
    }

    @Test
    void parsedDocumentRejectsUnderreportedListWithoutConsumingItemPastLimit() {
        AtomicInteger consumed = new AtomicInteger();
        var hostile = new AbstractList<DocumentIntelligenceV1.Page>() {
            @Override
            public DocumentIntelligenceV1.Page get(int index) {
                throw new AssertionError("bounded copy must use the iterator");
            }

            @Override
            public int size() {
                return 0;
            }

            @Override
            public Iterator<DocumentIntelligenceV1.Page> iterator() {
                return new Iterator<>() {
                    private int remaining = DocumentIntelligenceV1.MAX_PAGES + 1;

                    @Override
                    public boolean hasNext() {
                        return remaining > 0;
                    }

                    @Override
                    public DocumentIntelligenceV1.Page next() {
                        if (!hasNext()) throw new NoSuchElementException();
                        remaining--;
                        consumed.incrementAndGet();
                        return null;
                    }
                };
            }
        };

        assertThatThrownBy(() -> new DocumentIntelligenceV1.ParsedDocument(
                DocumentIntelligenceV1.PROTOCOL_VERSION, "operation-1", "di.ocr.en", null, hostile))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("pages");
        org.assertj.core.api.Assertions.assertThat(consumed).hasValue(DocumentIntelligenceV1.MAX_PAGES);
    }
}
