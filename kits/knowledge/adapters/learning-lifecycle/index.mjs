/** Public owner implementation; installed consumers supply trusted host capabilities. */
export { createKnowledgeLearningLifecycle, emptyKnowledgeLearningRegistry } from '@kontourai/flow-agents/knowledge-learning';
export { createLocalFileKnowledgeLearningStore, parseKnowledgeLearningRegistry } from '@kontourai/flow-agents/knowledge-learning-file';
export { KNOWLEDGE_LEARNING_VERSION, KNOWLEDGE_LEARNING_LIMITS, KnowledgeLearningError, isKnowledgeLearningActive } from '@kontourai/flow-agents/knowledge-learning-contract';
