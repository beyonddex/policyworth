// /js/survey.js
// Survey Builder with Firestore backend

import { auth, db } from '/js/auth.js';
import {
  collection,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  orderBy,
  serverTimestamp,
  onSnapshot
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

// ============================================
// STATE
// ============================================

let currentUser = null;
let currentSurvey = null;
let currentSurveyId = null;
let unsub = null;

// ============================================
// DOM ELEMENTS
// ============================================

const listView = document.getElementById('listView');
const builderView = document.getElementById('builderView');
const createNewBtn = document.getElementById('createNewBtn');
const backBtn = document.getElementById('backBtn');
const surveysList = document.getElementById('surveysList');
const emptyState = document.getElementById('emptyState');

const surveyTitle = document.getElementById('surveyTitle');
const surveyStatus = document.getElementById('surveyStatus');
const statusIcon = document.getElementById('statusIcon');
const statusText = document.getElementById('statusText');
const questionsList = document.getElementById('questionsList');
const addQuestionBtn = document.getElementById('addQuestionBtn');
const addQuestionArea = document.getElementById('addQuestionArea');
const messageContainer = document.getElementById('messageContainer');

const saveDraftBtn = document.getElementById('saveDraftBtn');
const lockBtn = document.getElementById('lockBtn');
const deleteBtn = document.getElementById('deleteBtn');

// ============================================
// HELPERS
// ============================================

function generateId() {
  return Math.random().toString(36).substring(2, 15);
}

function showMessage(text, type = 'info') {
  const icons = {
    success: '✓',
    error: '⚠',
    info: 'ℹ'
  };
  
  const msg = document.createElement('div');
  msg.className = `message ${type}`;
  msg.innerHTML = `<strong>${icons[type]}</strong> ${text}`;
  messageContainer.innerHTML = '';
  messageContainer.appendChild(msg);
  
  if (type === 'success') {
    setTimeout(() => msg.remove(), 3000);
  }
}

function clearMessage() {
  messageContainer.innerHTML = '';
}

// ============================================
// NAVIGATION
// ============================================

function showListView() {
  listView.style.display = 'block';
  builderView.style.display = 'none';
  currentSurvey = null;
  currentSurveyId = null;
  clearMessage();
}

function showBuilderView(survey = null, surveyId = null) {
  listView.style.display = 'none';
  builderView.style.display = 'block';
  
  if (survey && surveyId) {
    currentSurvey = survey;
    currentSurveyId = surveyId;
    loadSurveyToBuilder(survey);
  } else {
    // New survey
    currentSurvey = createEmptySurvey();
    currentSurveyId = null;
  }
  
  clearMessage();
}

// ============================================
// SURVEY CRUD
// ============================================

function createEmptySurvey() {
  return {
    title: 'Untitled Survey',
    locked: false,
    questions: [
      {
        id: 'core_yesno',
        type: 'yesno',
        label: 'Did the client receive service?',
        required: true,
        core: true
      }
    ],
    createdAt: new Date(),
    updatedAt: new Date()
  };
}

async function loadSurveys() {
  if (!currentUser) return;
  
  try {
    const surveysRef = collection(db, 'users', currentUser.uid, 'surveys');
    const q = query(surveysRef, orderBy('createdAt', 'desc'));
    
    const snapshot = await getDocs(q);
    const surveys = [];
    
    snapshot.forEach(doc => {
      surveys.push({
        id: doc.id,
        ...doc.data()
      });
    });
    
    renderSurveysList(surveys);
  } catch (error) {
    console.error('Error loading surveys:', error);
    showMessage('Failed to load surveys. Please refresh the page.', 'error');
  }
}

function renderSurveysList(surveys) {
  if (surveys.length === 0) {
    surveysList.style.display = 'none';
    emptyState.style.display = 'block';
    return;
  }
  
  surveysList.style.display = 'grid';
  emptyState.style.display = 'none';
  
  surveysList.innerHTML = surveys.map(survey => `
    <div class="survey-item" data-id="${survey.id}">
      <div class="survey-item-header">
        <div>
          <div class="survey-item-title">${survey.title || 'Untitled Survey'}</div>
          <div class="survey-item-meta">
            ${survey.questions?.length || 0} questions
            ${survey.createdAt ? `• Created ${formatDate(survey.createdAt)}` : ''}
          </div>
        </div>
        <div class="survey-item-badge ${survey.locked ? '' : 'draft'}">
          ${survey.locked ? '🔒 Active' : '📝 Draft'}
        </div>
      </div>
    </div>
  `).join('');
  
  // Add click handlers
  document.querySelectorAll('.survey-item').forEach(item => {
    item.addEventListener('click', async () => {
      const surveyId = item.dataset.id;
      const surveyDoc = await getDoc(doc(db, 'users', currentUser.uid, 'surveys', surveyId));
      if (surveyDoc.exists()) {
        showBuilderView(surveyDoc.data(), surveyId);
      }
    });
  });
}

function formatDate(timestamp) {
  if (!timestamp) return '';
  const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

async function saveSurvey(showSuccessMessage = true) {
  if (!currentUser) {
    showMessage('Please sign in to save.', 'error');
    return;
  }
  
  // Validation
  if (!surveyTitle.value.trim()) {
    showMessage('Please enter a survey title.', 'error');
    return;
  }
  
  if (currentSurvey.questions.length === 0) {
    showMessage('Survey must have at least one question.', 'error');
    return;
  }
  
  // Check for core yes/no question
  const hasCore = currentSurvey.questions.some(q => q.id === 'core_yesno' && q.type === 'yesno');
  if (!hasCore) {
    showMessage('Survey must include the core Yes/No question.', 'error');
    return;
  }
  
  const surveyData = {
    title: surveyTitle.value.trim(),
    locked: currentSurvey.locked,
    questions: currentSurvey.questions,
    updatedAt: serverTimestamp()
  };
  
  try {
    if (currentSurveyId) {
      // Update existing
      await updateDoc(doc(db, 'users', currentUser.uid, 'surveys', currentSurveyId), surveyData);
      if (showSuccessMessage) {
        showMessage('Survey saved successfully!', 'success');
      }
    } else {
      // Create new
      surveyData.createdAt = serverTimestamp();
      const docRef = await addDoc(collection(db, 'users', currentUser.uid, 'surveys'), surveyData);
      currentSurveyId = docRef.id;
      if (showSuccessMessage) {
        showMessage('Survey created successfully!', 'success');
      }
    }
    
    // Update local state
    currentSurvey.title = surveyData.title;
    
  } catch (error) {
    console.error('Error saving survey:', error);
    showMessage('Failed to save survey. Please try again.', 'error');
  }
}

async function lockSurvey() {
  if (!currentUser || !currentSurveyId) return;
  
  // Validate
  if (!surveyTitle.value.trim()) {
    showMessage('Please enter a survey title before locking.', 'error');
    return;
  }
  
  if (currentSurvey.questions.length === 0) {
    showMessage('Survey must have at least one question.', 'error');
    return;
  }
  
  const hasCore = currentSurvey.questions.some(q => q.id === 'core_yesno' && q.type === 'yesno');
  if (!hasCore) {
    showMessage('Survey must include the core Yes/No question.', 'error');
    return;
  }
  
  if (!confirm('Once locked, you cannot modify this survey. Continue?')) {
    return;
  }
  
  try {
    currentSurvey.locked = true;
    await updateDoc(doc(db, 'users', currentUser.uid, 'surveys', currentSurveyId), {
      locked: true,
      title: surveyTitle.value.trim(),
      questions: currentSurvey.questions,
      updatedAt: serverTimestamp()
    });
    
    updateStatusDisplay();
    updateButtonStates();
    showMessage('Survey locked and activated!', 'success');
  } catch (error) {
    console.error('Error locking survey:', error);
    showMessage('Failed to lock survey. Please try again.', 'error');
  }
}

async function deleteSurvey() {
  if (!currentUser || !currentSurveyId) return;
  
  if (currentSurvey.locked) {
    showMessage('Cannot delete a locked survey.', 'error');
    return;
  }
  
  if (!confirm('Are you sure you want to delete this survey? This cannot be undone.')) {
    return;
  }
  
  try {
    await deleteDoc(doc(db, 'users', currentUser.uid, 'surveys', currentSurveyId));
    showMessage('Survey deleted successfully.', 'success');
    setTimeout(() => showListView(), 1500);
  } catch (error) {
    console.error('Error deleting survey:', error);
    showMessage('Failed to delete survey. Please try again.', 'error');
  }
}

// ============================================
// SURVEY BUILDER UI
// ============================================

function loadSurveyToBuilder(survey) {
  surveyTitle.value = survey.title || '';
  currentSurvey = { ...survey };
  
  updateStatusDisplay();
  updateButtonStates();
  renderQuestions();
}

function updateStatusDisplay() {
  if (currentSurvey.locked) {
    statusIcon.textContent = '🔒';
    statusText.textContent = 'Active';
    surveyStatus.classList.add('locked');
  } else {
    statusIcon.textContent = '🔓';
    statusText.textContent = 'Draft';
    surveyStatus.classList.remove('locked');
  }
}

function updateButtonStates() {
  const isLocked = currentSurvey.locked;
  
  surveyTitle.disabled = isLocked;
  addQuestionBtn.disabled = isLocked;
  lockBtn.disabled = isLocked;
  deleteBtn.disabled = isLocked;
  
  if (isLocked) {
    lockBtn.textContent = '🔒 Locked';
    addQuestionBtn.textContent = 'Survey is Locked';
  } else {
    lockBtn.textContent = 'Lock & Activate';
    addQuestionBtn.textContent = '+ Add Question';
  }
}

function renderQuestions() {
  if (currentSurvey.questions.length === 0) {
    questionsList.innerHTML = '<p style="color: var(--pw-muted); text-align: center; padding: 20px;">No questions yet. Add your first question below.</p>';
    return;
  }
  
  questionsList.innerHTML = currentSurvey.questions.map((q, index) => `
    <div class="question-card ${q.core ? 'core' : ''}" data-index="${index}">
      <div class="question-header">
        <div>
          <div style="margin-bottom: 8px;">
            <span class="question-type-badge ${q.core ? 'core' : ''}">${q.core ? '🔒 Core' : getTypeLabel(q.type)}</span>
          </div>
          <input 
            type="text" 
            class="pw-input question-label" 
            data-index="${index}" 
            value="${q.label || ''}" 
            placeholder="Enter question text"
            ${currentSurvey.locked || q.core ? 'readonly' : ''}
            style="${currentSurvey.locked || q.core ? 'background: #f9fafb; cursor: not-allowed;' : ''}"
          />
          <div style="margin-top: 12px; font-size: 13px; color: var(--pw-muted);">
            ${q.core ? '✓ Required (Core Question)' : q.required ? '✓ Required' : 'Optional'}
          </div>
        </div>
        ${!q.core && !currentSurvey.locked ? `
          <div class="question-actions">
            <button class="icon-btn" data-action="up" data-index="${index}" ${index === 0 ? 'disabled' : ''}>↑</button>
            <button class="icon-btn" data-action="down" data-index="${index}" ${index === currentSurvey.questions.length - 1 ? 'disabled' : ''}>↓</button>
            <button class="icon-btn" data-action="delete" data-index="${index}">🗑</button>
          </div>
        ` : ''}
      </div>
      
      ${q.type === 'select' ? `
        <div style="margin-top: 12px;">
          <label class="pw-label">Options (comma-separated)</label>
          <input 
            type="text" 
            class="pw-input question-options" 
            data-index="${index}" 
            value="${(q.options || []).join(', ')}" 
            placeholder="Option 1, Option 2, Option 3"
            ${currentSurvey.locked ? 'readonly' : ''}
            style="${currentSurvey.locked ? 'background: #f9fafb; cursor: not-allowed;' : ''}"
          />
        </div>
      ` : ''}
    </div>
  `).join('');
  
  // Add event listeners
  attachQuestionEventListeners();
}

function attachQuestionEventListeners() {
  // Question label inputs
  document.querySelectorAll('.question-label').forEach(input => {
    input.addEventListener('blur', () => {
      const index = parseInt(input.dataset.index);
      currentSurvey.questions[index].label = input.value;
    });
  });
  
  // Question options inputs
  document.querySelectorAll('.question-options').forEach(input => {
    input.addEventListener('blur', () => {
      const index = parseInt(input.dataset.index);
      const options = input.value.split(',').map(o => o.trim()).filter(o => o);
      currentSurvey.questions[index].options = options;
    });
  });
  
  // Action buttons
  document.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const action = btn.dataset.action;
      const index = parseInt(btn.dataset.index);
      
      switch (action) {
        case 'up':
          moveQuestion(index, index - 1);
          break;
        case 'down':
          moveQuestion(index, index + 1);
          break;
        case 'delete':
          deleteQuestion(index);
          break;
      }
    });
  });
}

function moveQuestion(fromIndex, toIndex) {
  const [question] = currentSurvey.questions.splice(fromIndex, 1);
  currentSurvey.questions.splice(toIndex, 0, question);
  renderQuestions();
}

function deleteQuestion(index) {
  if (currentSurvey.questions[index].core) {
    showMessage('Cannot delete core question.', 'error');
    return;
  }
  
  if (confirm('Delete this question?')) {
    currentSurvey.questions.splice(index, 1);
    renderQuestions();
  }
}

function addQuestion(type) {
  const newQuestion = {
    id: generateId(),
    type: type,
    label: '',
    required: false,
    core: false
  };
  
  if (type === 'select') {
    newQuestion.options = [];
  }
  
  currentSurvey.questions.push(newQuestion);
  renderQuestions();
  
  // Hide add area
  addQuestionArea.style.display = 'none';
  
  // Focus on new question label
  setTimeout(() => {
    const inputs = document.querySelectorAll('.question-label');
    if (inputs.length > 0) {
      inputs[inputs.length - 1].focus();
    }
  }, 100);
}

function getTypeLabel(type) {
  const labels = {
    text: '📝 Text',
    number: '🔢 Number',
    yesno: '✓✗ Yes/No',
    select: '📋 Select'
  };
  return labels[type] || type;
}

// ============================================
// EVENT HANDLERS
// ============================================

createNewBtn?.addEventListener('click', () => {
  showBuilderView();
});

// Handle empty state button
emptyState?.querySelector('.pw-btn')?.addEventListener('click', () => {
  showBuilderView();
});

backBtn?.addEventListener('click', () => {
  if (!currentSurvey.locked && currentSurveyId) {
    if (confirm('Save changes before leaving?')) {
      saveSurvey(false);
    }
  }
  showListView();
  loadSurveys();
});

addQuestionBtn?.addEventListener('click', () => {
  if (currentSurvey.locked) return;
  addQuestionArea.style.display = addQuestionArea.style.display === 'none' ? 'block' : 'none';
});

// Type option clicks
document.querySelectorAll('.type-option').forEach(option => {
  option.addEventListener('click', () => {
    const type = option.dataset.type;
    addQuestion(type);
  });
});

surveyTitle?.addEventListener('input', () => {
  currentSurvey.title = surveyTitle.value;
});

saveDraftBtn?.addEventListener('click', () => saveSurvey(true));
lockBtn?.addEventListener('click', () => lockSurvey());
deleteBtn?.addEventListener('click', () => deleteSurvey());

// ============================================
// AUTH
// ============================================

onAuthStateChanged(auth, (user) => {
  if (user) {
    currentUser = user;
    loadSurveys();
  } else {
    currentUser = null;
    surveysList.innerHTML = '<p style="text-align: center; color: var(--pw-muted); padding: 40px;">Please sign in to view surveys.</p>';
  }
});

// ============================================
// INIT
// ============================================

console.log('[survey] Survey builder loaded');