import { supabase } from '@/integrations/supabase/client';
import { Quiz, QuizQuestion, QuizSettings, Warning, JsonWarning } from '@/types';

export async function saveQuiz(
  title: string, 
  description: string, 
  settings: QuizSettings,
  questions: QuizQuestion[],
  userId: string
): Promise<{ success: boolean; id: string; testId: string; error?: any }> {
  try {
    // Generate a unique test ID (uppercase letters and numbers)
    const testId = Math.random().toString(36).substring(2, 8).toUpperCase();
    
    console.log('Creating new quiz with title:', title);
    console.log('Question count before saving:', questions.length);
    
    // Insert the quiz - explicitly cast settings to Json type expected by Supabase
    const { data: quizData, error: quizError } = await supabase
      .from('quizzes')
      .insert({
        title,
        description,
        settings: settings as any,
        created_by: userId,
        test_id: testId
      })
      .select()
      .single();
    
    if (quizError) {
      console.error('Error creating quiz:', quizError);
      return {
        success: false,
        id: '',
        testId: '',
        error: quizError
      };
    }

    console.log('Quiz created successfully:', quizData);
    console.log('Quiz ID for questions:', quizData.id);

    // Insert all questions
    if (questions.length > 0) {
      // IMPORTANT: Make sure we're using the correct quiz_id from the newly created quiz
      const newQuizId = quizData.id;
      
      // Log the quiz ID to ensure it's correct
      console.log('Using quiz ID for all questions:', newQuizId);
      
      // Create a proper array of questions to insert, ensuring each has the correct quiz_id
      const questionsToInsert = questions.map(question => {
        // Ensure each question has the correct quiz_id in the right format
        const formattedQuestion = {
          quiz_id: newQuizId, // Explicitly use the new quiz ID
          text: question.text,
          type: question.type,
          options: question.options,
          correct_answers: question.correctAnswers,
          points: question.points
        };
        
        // Double check that we're using the right quiz_id
        if (formattedQuestion.quiz_id !== newQuizId) {
          console.error('Quiz ID mismatch when formatting questions:', {
            expected: newQuizId,
            actual: formattedQuestion.quiz_id
          });
        }
        
        return formattedQuestion;
      });
      
      console.log('Inserting questions for quiz_id:', newQuizId);
      console.log('Questions count to insert:', questionsToInsert.length);
      questionsToInsert.forEach((q, i) => {
        console.log(`Question ${i+1} to insert:`, {
          quiz_id: q.quiz_id,
          text: q.text.substring(0, 30) + '...',
          type: q.type
        });
      });
      
      // Debug potential issues before inserting
      if (questionsToInsert.some(q => !q.quiz_id || q.quiz_id !== newQuizId)) {
        console.error('Warning: Some questions have incorrect quiz_id');
      }
      
      // Insert questions
      const { data: insertedQuestions, error: questionsError } = await supabase
        .from('questions')
        .insert(questionsToInsert)
        .select();
      
      if (questionsError) {
        console.error('Error inserting questions:', questionsError);
        return {
          success: false,
          id: quizData.id,
          testId,
          error: questionsError
        };
      }
      
      console.log('Questions inserted successfully. Count:', insertedQuestions?.length || 0);
      if (insertedQuestions) {
        insertedQuestions.forEach((q, index) => {
          console.log(`Inserted Question ${index + 1}:`, {
            id: q.id,
            quiz_id: q.quiz_id,
            text: q.text.substring(0, 30) + '...',
            type: q.type
          });
        });
      }
      
      // Verify that questions were inserted with the correct quiz_id
      const { data: verifyQuestions, error: verifyError } = await supabase
        .from('questions')
        .select('*')
        .eq('quiz_id', newQuizId);
        
      if (!verifyError) {
        console.log(`Verification: Found ${verifyQuestions?.length || 0} questions with quiz_id ${newQuizId}`);
      }
    }

    return {
      success: true,
      id: quizData.id,
      testId
    };
  } catch (error) {
    console.error('Error saving quiz:', error);
    return {
      success: false,
      id: '',
      testId: '',
      error
    };
  }
}

export async function createInitialAttempt(
  quizId: string,
  studentId: string
): Promise<{ 
  success: boolean; 
  id?: string; 
  attemptId?: string; 
  answers?: Record<string, number[]>; 
  warnings?: Warning[]; 
  message?: string; 
  error?: any 
}> {
  try {
    console.log(`Creating initial attempt for student ${studentId} on quiz ${quizId}`);
    
    // First, check if the student has already submitted this quiz
    const { data: existingAttempts, error: checkError } = await supabase
      .from('quiz_attempts')
      .select('id, answers, submitted_at, warnings')
      .eq('quiz_id', quizId)
      .eq('student_id', studentId);
    
    if (checkError) {
      console.error('Error checking for existing attempts:', checkError);
      throw checkError;
    }
    
    // If a submitted attempt exists, prevent another attempt
    if (existingAttempts && existingAttempts.length > 0) {
      const submittedAttempt = existingAttempts.find(attempt => attempt.submitted_at !== null);
      
      if (submittedAttempt) {
        console.log('Student has already submitted this quiz');
        return {
          success: false,
          message: 'You have already submitted this quiz. Only one attempt is allowed per student.'
        };
      }
      
      // If there's an ongoing attempt that hasn't been submitted yet, return its ID
      const ongoingAttempt = existingAttempts.find(attempt => attempt.submitted_at === null);
      if (ongoingAttempt) {
        console.log('Ongoing attempt found, returning ID:', ongoingAttempt.id);
        
        // Parse warnings from the database
        let warnings: Warning[] = [];
        if (ongoingAttempt.warnings && Array.isArray(ongoingAttempt.warnings)) {
          warnings = ongoingAttempt.warnings.map((w: any) => ({
            timestamp: w.timestamp || new Date().toISOString(),
            type: w.type || 'focus-loss',
            description: w.description || ''
          }));
        }
        
        return {
          success: true,
          attemptId: ongoingAttempt.id,
          answers: ongoingAttempt.answers as Record<string, number[]> || {},
          warnings: warnings
        };
      }
    }
    
    // If no existing attempt, create a new one
    const { data: attemptData, error: attemptError } = await supabase
      .from('quiz_attempts')
      .insert({
        quiz_id: quizId,
        student_id: studentId,
        answers: {},
        warnings: [],
        // Note: submitted_at is null to indicate this is an ongoing attempt
      })
      .select()
      .single();
    
    if (attemptError) {
      console.error('Error creating attempt:', attemptError);
      throw attemptError;
    }
    
    console.log('Successfully created initial attempt:', attemptData.id);
    
    return {
      success: true,
      id: attemptData.id,
      warnings: []
    };
  } catch (error: any) {
    console.error('Error creating initial attempt:', error);
    return {
      success: false,
      error,
      message: error.message || 'An error occurred while creating the attempt',
      warnings: []
    };
  }
}

export async function updateQuizAttemptAnswers(
  attemptId: string,
  answers: Record<string, number[]>
): Promise<boolean> {
  try {
    console.log(`Updating answers for attempt ${attemptId}`);
    
    const { error } = await supabase
      .from('quiz_attempts')
      .update({
        answers: answers
      })
      .eq('id', attemptId);
    
    if (error) {
      console.error('Error updating attempt answers:', error);
      return false;
    }
    
    return true;
  } catch (error) {
    console.error('Error updating attempt answers:', error);
    return false;
  }
}

export async function saveQuizAttempt(
  attemptId: string,
  quizId: string,
  studentId: string,
  answers: Record<string, number[]>,
  warnings: Warning[] = [],
  autoSubmitted: boolean = false
): Promise<{ success: boolean; id: string; error?: any; message?: string }> {
  try {
    console.log(`Submitting quiz attempt ${attemptId} for student ${studentId}`);
    console.log(`Warnings count being saved: ${warnings.length}`);
    
    if (warnings.length > 0) {
      console.log('Warning details being saved:', JSON.stringify(warnings.slice(0, 2)));
    }
    
    // Calculate the score by comparing answers with correct answers
    const { data: questions, error: questionsError } = await supabase
      .from('questions')
      .select('id, correct_answers, points')
      .eq('quiz_id', quizId);
    
    if (questionsError) {
      throw questionsError;
    }
    
    // Calculate the score
    let totalScore = 0;
    let totalPossibleScore = 0;
    
    questions.forEach((question: any) => {
      totalPossibleScore += question.points;
      
      const studentAnswers = answers[question.id] || [];
      const correctAnswers = question.correct_answers || [];
      
      // For a perfect match (all correct options selected and no incorrect ones)
      if (
        studentAnswers.length === correctAnswers.length &&
        studentAnswers.every(answer => correctAnswers.includes(answer))
      ) {
        totalScore += question.points;
      }
    });
    
    // Calculate percentage score (rounded to nearest integer)
    const scorePercentage = Math.round((totalScore / totalPossibleScore) * 100);
    
    // Ensure warnings are properly formatted for database storage
    // Convert warnings to proper format for database storage
    const jsonWarnings: JsonWarning[] = warnings.map(warning => ({
      type: warning.type,
      timestamp: warning.timestamp,
      description: warning.description || ''
    }));
    
    console.log(`Saving ${jsonWarnings.length} warnings to database for attempt ${attemptId}`);
    console.log('JSON warnings structure:', JSON.stringify(jsonWarnings));
    
    // Update the attempt with submission data - ensure warnings are properly saved
    const { data: attemptData, error: attemptError } = await supabase
      .from('quiz_attempts')
      .update({
        answers: answers,
        warnings: jsonWarnings,
        auto_submitted: autoSubmitted,
        score: scorePercentage,
        submitted_at: new Date().toISOString()
      })
      .eq('id', attemptId)
      .select()
      .single();
    
    if (attemptError) {
      console.error('Error updating quiz attempt:', attemptError);
      throw attemptError;
    }
    
    // Verify warnings were saved correctly
    console.log('Attempt data after update:', {
      id: attemptData.id,
      warnings_count: Array.isArray(attemptData.warnings) ? attemptData.warnings.length : 'Not an array',
      warnings_sample: attemptData.warnings ? JSON.stringify(attemptData.warnings).substring(0, 100) + '...' : 'No warnings',
      auto_submitted: attemptData.auto_submitted
    });
    
    return {
      success: true,
      id: attemptData.id
    };
  } catch (error: any) {
    console.error('Error saving quiz attempt:', error);
    return {
      success: false,
      id: '',
      error,
      message: error.message || 'An error occurred while submitting the quiz'
    };
  }
}

export async function deleteQuiz(
  quizId: string
): Promise<{ success: boolean; error?: any }> {
  try {
    console.log('Deleting quiz and related data for quiz ID:', quizId);
    
    // First, delete all questions associated with the quiz
    const { error: questionsError } = await supabase
      .from('questions')
      .delete()
      .eq('quiz_id', quizId);
      
    if (questionsError) {
      console.error('Error deleting questions for quiz:', questionsError);
      throw questionsError;
    }
    
    console.log('Successfully deleted all questions for quiz ID:', quizId);
    
    // Delete any quiz attempts associated with this quiz
    const { error: attemptsError } = await supabase
      .from('quiz_attempts')
      .delete()
      .eq('quiz_id', quizId);
    
    if (attemptsError) {
      console.error('Error deleting quiz attempts:', attemptsError);
      // Continue with deletion even if attempts deletion fails
      console.warn('Continuing with quiz deletion despite error with attempts deletion');
    } else {
      console.log('Successfully deleted all attempts for quiz ID:', quizId);
    }
    
    // Then delete the quiz itself
    const { error: quizError } = await supabase
      .from('quizzes')
      .delete()
      .eq('id', quizId);
      
    if (quizError) {
      console.error('Error deleting quiz:', quizError);
      throw quizError;
    }
    
    console.log('Successfully deleted quiz with ID:', quizId);

    return {
      success: true
    };
  } catch (error) {
    console.error('Error in deleteQuiz function:', error);
    return {
      success: false,
      error
    };
  }
}

// Improved function to delete a specific quiz attempt
export async function deleteQuizAttempt(
  attemptId: string
): Promise<{ success: boolean; error?: any }> {
  try {
    console.log('Deleting quiz attempt with ID:', attemptId);
    
    // Get the attempt before deleting for logging purposes
    const { data: attemptToDelete, error: checkError } = await supabase
      .from('quiz_attempts')
      .select('id, student_id, quiz_id')
      .eq('id', attemptId)
      .single();
    
    if (checkError) {
      if (checkError.code === 'PGRST116') {
        console.warn('Attempt not found for deletion:', attemptId);
        return {
          success: false,
          error: new Error('Attempt not found')
        };
      }
      console.error('Error checking attempt before deletion:', checkError);
      throw checkError;
    }
    
    console.log('Found attempt to delete:', attemptToDelete);
    
    // Delete the specified quiz attempt
    const { error } = await supabase
      .from('quiz_attempts')
      .delete()
      .eq('id', attemptId);
      
    if (error) {
      console.error('Error deleting quiz attempt:', error);
      return {
        success: false,
        error
      };
    }
    
    // Verify deletion
    const { data: verifyDeletion, error: verifyError } = await supabase
      .from('quiz_attempts')
      .select('id')
      .eq('id', attemptId);
      
    if (verifyError) {
      console.error('Error verifying deletion:', verifyError);
    } else {
      if (verifyDeletion && verifyDeletion.length > 0) {
        console.warn('Attempt still exists after deletion attempt');
        return {
          success: false,
          error: new Error('Failed to delete attempt')
        };
      } else {
        console.log('Successfully verified deletion of quiz attempt with ID:', attemptId);
      }
    }
    
    return {
      success: true
    };
  } catch (error) {
    console.error('Error in deleteQuizAttempt function:', error);
    return {
      success: false,
      error
    };
  }
}
