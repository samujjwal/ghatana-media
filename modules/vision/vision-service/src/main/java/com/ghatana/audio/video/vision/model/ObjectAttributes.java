package com.ghatana.audio.video.vision.model;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.Map;
import java.util.Objects;

/**
 * Represents additional attributes for detected objects.
 *
 * @doc.type model
 * @doc.purpose Additional attributes and metadata for detected objects
 * @doc.layer product
 * @doc.pattern ValueObject
 */
public class ObjectAttributes {

    @JsonProperty("color")
    private final String color;

    @JsonProperty("size")
    private final String size;

    @JsonProperty("orientation")
    private final String orientation;

    @JsonProperty("additional_properties")
    private final Map<String, Object> additionalProperties;

    private ObjectAttributes(Builder builder) {
        this.color = builder.color;
        this.size = builder.size;
        this.orientation = builder.orientation;
        this.additionalProperties = builder.additionalProperties;
    }

    public String getColor() {
        return color;
    }

    public String getSize() {
        return size;
    }

    public String getOrientation() {
        return orientation;
    }

    public Map<String, Object> getAdditionalProperties() {
        return additionalProperties;
    }

    @SuppressWarnings("unchecked")
    public <T> T getProperty(String key, Class<T> type) {
        if (additionalProperties != null && additionalProperties.containsKey(key)) {
            Object value = additionalProperties.get(key);
            if (type.isInstance(value)) {
                return (T) value;
            }
        }
        return null;
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (o == null || getClass() != o.getClass()) return false;
        ObjectAttributes that = (ObjectAttributes) o;
        return Objects.equals(color, that.color) &&
               Objects.equals(size, that.size) &&
               Objects.equals(orientation, that.orientation) &&
               Objects.equals(additionalProperties, that.additionalProperties);
    }

    @Override
    public int hashCode() {
        return Objects.hash(color, size, orientation, additionalProperties);
    }

    @Override
    public String toString() {
        return "ObjectAttributes{" +
               "color='" + color + '\'' +
               ", size='" + size + '\'' +
               ", orientation='" + orientation + '\'' +
               ", additionalProperties=" + additionalProperties +
               '}';
    }

    public static Builder builder() {
        return new Builder();
    }

    public static class Builder {
        private String color;
        private String size;
        private String orientation;
        private Map<String, Object> additionalProperties;

        public Builder color(String color) {
            this.color = color;
            return this;
        }

        public Builder size(String size) {
            this.size = size;
            return this;
        }

        public Builder orientation(String orientation) {
            this.orientation = orientation;
            return this;
        }

        public Builder additionalProperties(Map<String, Object> additionalProperties) {
            this.additionalProperties = additionalProperties;
            return this;
        }

        public ObjectAttributes build() {
            return new ObjectAttributes(this);
        }
    }
}
